// Trang ánh xạ thông số sang sàn (#509, Documents/21 §18.8.1): đọc kèm gợi ý tính lúc đọc, thay tập mã của một thông số, tìm
// attribute đã gặp của sàn. Không gọi sàn: chỉ đọc `platform_category_attributes` đã lấy.
import { type EventEnvelope, type EventPayload, recordAudit } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import type { ModuleContext } from '../../../../shared/module.ts';
import { type AttributeKind, normalizePath } from '../domain/product-spec.ts';
import { isMarketplace } from '../repository/schema.ts';
import type { FieldMapping } from '../domain/spec-resolve.ts';
import {
  attributesByCodes,
  type CatalogAttribute,
  codesTakenByOthers,
  deleteFieldMappings,
  deleteOptionMappings,
  mappingsOf,
  propertyAttributesOf,
  replaceFieldMapping,
  seedFieldMappings,
  searchAttributeCatalog,
} from '../repository/spec-mappings.ts';
import { getAdapter, registeredPlatforms } from './marketplaces/index.ts';
import { catalogSpecPort, productPort, type SpecFieldInfo } from './product-port.ts';
import { platformOf } from './shops.ts';

interface MappingOption {
  optionId: string;
  platformOptionId: string | null;
  platformLabel: string | null;
}
export interface SpecMapping {
  fieldId: string;
  codes: { attributeCode: string; attributeLabel: string; priority: number; options: MappingOption[] }[];
  suggestions: { attributeCode: string; attributeLabel: string; options: MappingOption[] }[];
}

const hasOptions = (f: SpecFieldInfo) => f.input === 'select' || f.input === 'multiselect';

/** Lựa chọn của thông số kèm lựa chọn sàn đã ánh xạ (`known`), hoặc ghép theo nhãn khi gợi ý (`byLabel`). */
function optionRows(field: SpecFieldInfo, attr: CatalogAttribute | undefined, known: ReadonlyMap<string, string> | null): MappingOption[] {
  if (!hasOptions(field)) return [];
  const label = new Map((attr?.options ?? []).map((o) => [o.id, o.label]));
  const byLabel = new Map((attr?.options ?? []).map((o) => [normalizePath(o.label), o.id]));
  return [...field.options]
    .sort((a, b) => a.position - b.position)
    .map((o) => {
      const id = known ? (known.get(o.id) ?? null) : (byLabel.get(normalizePath(o.value)) ?? null);
      return { optionId: o.id, platformOptionId: id, platformLabel: id === null ? null : (label.get(id) ?? null) };
    });
}

function toMappings(
  fields: readonly SpecFieldInfo[],
  mappings: readonly FieldMapping[],
  attrs: ReadonlyMap<string, CatalogAttribute>,
  properties: readonly CatalogAttribute[],
): SpecMapping[] {
  const taken = new Set(mappings.map((m) => m.attributeCode));
  return fields.map((field) => {
    const own = mappings.filter((m) => m.fieldId === field.id).sort((a, b) => a.priority - b.priority);
    const name = normalizePath(field.name);
    return {
      fieldId: field.id,
      codes: own.map((m) => ({
        attributeCode: m.attributeCode,
        attributeLabel: attrs.get(m.attributeCode)?.label ?? m.attributeCode,
        priority: m.priority,
        options: optionRows(field, attrs.get(m.attributeCode), m.options),
      })),
      // Gợi ý tính lúc đọc, không lưu (§18.8.1): attribute property trùng tên thông số, mã chưa ánh xạ cho thông số nào.
      suggestions: properties
        .filter((a) => !taken.has(a.code) && normalizePath(a.label) === name)
        .map((a) => ({ attributeCode: a.code, attributeLabel: a.label, options: optionRows(field, a, null) })),
    };
  });
}

/** `GET /channel/platforms/:platform/spec-mappings`: mỗi thông số của công ty một dòng. */
export async function listSpecMappings(ctx: ModuleContext, companyId: string, raw: string): Promise<{ items: SpecMapping[] }> {
  const { platform } = platformOf(raw);
  return withCompany(companyId, async () => {
    const fields = (await productPort(ctx).specFields?.()) ?? [];
    const mappings = await mappingsOf(platform);
    const attrs = await attributesByCodes(platform, mappings.map((m) => m.attributeCode));
    const properties = await propertyAttributesOf(platform);
    return { items: toMappings(fields, mappings, attrs, properties) };
  });
}

export interface SpecMappingInput {
  codes: { attributeCode: string; options?: { optionId: string; platformOptionId: string | null }[] }[];
}

/** `PUT /channel/platforms/:platform/spec-mappings/:fieldId`: thay cả tập mã; thứ tự mảng là `priority`. */
export async function putSpecMapping(
  ctx: ModuleContext,
  actor: { companyId: string; accountId: string },
  raw: string,
  fieldId: string,
  input: SpecMappingInput,
): Promise<SpecMapping> {
  const { platform, adapter } = platformOf(raw);
  return withCompany(actor.companyId, async () => {
    const fields = (await productPort(ctx).specFields?.()) ?? [];
    const field = fields.find((f) => f.id === fieldId);
    if (!field) throw new AppError(404, 'not_found', 'Không tìm thấy thông số');
    const codes = input.codes.map((c) => c.attributeCode);
    const attrs = await attributesByCodes(platform, codes);
    const taken = await codesTakenByOthers(platform, fieldId, codes);
    const optionIds = new Set(field.options.map((o) => o.id));
    const errors: Record<string, string> = {};
    const seen = new Set<string>();
    input.codes.forEach((c, i) => {
      const key = `codes.${i}.attributeCode`;
      const attr = attrs.get(c.attributeCode);
      if (seen.has(c.attributeCode)) errors[key] = 'Mã bị lặp';
      else if (!attr || attr.kind !== 'property') errors[key] = `Không phải thuộc tính sản phẩm đã gặp trên ${adapter.name}`;
      else if (taken.has(c.attributeCode)) errors[key] = 'Mã này đã ánh xạ cho thông số khác';
      seen.add(c.attributeCode);
      const platformIds = new Set((attr?.options ?? []).map((o) => o.id));
      (c.options ?? []).forEach((o, j) => {
        if (!hasOptions(field) || !optionIds.has(o.optionId)) errors[`codes.${i}.options.${j}`] = 'Không phải lựa chọn của thông số';
        else if (o.platformOptionId !== null && !platformIds.has(o.platformOptionId)) {
          errors[`codes.${i}.options.${j}`] = 'Không có trong lựa chọn của thuộc tính trên sàn';
        }
      });
    });
    if (Object.keys(errors).length) throw new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', { errors });
    const before = (await mappingsOf(platform, [fieldId])).map((m) => m.attributeCode);
    await replaceFieldMapping(
      actor.companyId,
      platform,
      fieldId,
      input.codes.map((c) => ({
        attributeCode: c.attributeCode,
        options: (c.options ?? []).flatMap((o) => (o.platformOptionId === null ? [] : [{ optionId: o.optionId, platformOptionId: o.platformOptionId }])),
      })),
    );
    await recordAudit({
      companyId: actor.companyId,
      actorId: actor.accountId,
      action: 'update',
      entityType: 'channel.spec_field_mappings',
      entityId: fieldId,
      label: `${field.name} · ${adapter.name}`,
      before: { codes: before },
      after: { codes },
    });
    const mappings = await mappingsOf(platform);
    const [item] = toMappings([field], mappings, attrs, await propertyAttributesOf(platform));
    return item!;
  });
}

/** `GET /channel/platforms/:platform/attribute-catalog`: attribute đã gặp ở các leaf đã lấy, gộp theo mã. */
export async function attributeCatalog(raw: string, search: string, kind: AttributeKind | undefined) {
  const { platform } = platformOf(raw);
  return { items: await searchAttributeCatalog(platform, search.trim(), kind) };
}

/**
 * Ánh xạ mặc định cho công ty mới (cổng `seedSpecMappings`, Documents/21 §11.3): mỗi sàn có adapter khai
 * `defaultSpecMappings`, tra thông số theo `code` qua `getSpecFields`, thông số không có thì bỏ. Chạy trong giao dịch tạo công
 * ty của bên gọi (không trong `withCompany`), sau `seedCompanyDefaults` của catalog. Chạy lại không trùng (bỏ dòng đã có). Lựa chọn không seed: lúc đẩy
 * khớp theo nhãn với lựa chọn của leaf (`resolveSpecAttributes`).
 */
export async function seedSpecMappings(companyId: string): Promise<void> {
  // Giao dịch tạo công ty không thuộc công ty nào (role chủ bảng, chưa có `app.company_id`): không lồng `withCompany`
  // được, nên đọc thông số lọc tường minh theo `companyId` và ghi `company_id` tường minh như seed của catalog.
  const fields = (await catalogSpecPort().specFields?.({ companyId })) ?? [];
  const idOf = new Map(fields.map((f) => [f.code, f.id]));
  for (const platform of registeredPlatforms()) {
    const defaults = getAdapter(platform)?.defaultSpecMappings;
    if (!defaults || !isMarketplace(platform)) continue;
    const rows = Object.entries(defaults).flatMap(([code, attributeCodes]) => {
      const fieldId = idOf.get(code);
      return fieldId ? attributeCodes.map((attributeCode, i) => ({ fieldId, attributeCode, priority: i + 1 })) : [];
    });
    await seedFieldMappings(companyId, platform, rows);
  }
}

/** Catalog xoá thông số (`catalog.spec_field_deleted`, consumer `channel-spec-field-deleted`): bỏ mọi ánh xạ của nó. */
export async function onSpecFieldDeleted(e: EventEnvelope<'catalog.spec_field_deleted', EventPayload<'catalog.spec_field_deleted'>>): Promise<void> {
  if (!e.companyId) return;
  await withCompany(e.companyId, () => deleteFieldMappings(e.payload.fieldId));
}

/** Catalog xoá lựa chọn (`catalog.spec_option_deleted`, consumer `channel-spec-option-deleted`): bỏ ánh xạ lựa chọn đó. */
export async function onSpecOptionDeleted(e: EventEnvelope<'catalog.spec_option_deleted', EventPayload<'catalog.spec_option_deleted'>>): Promise<void> {
  if (!e.companyId) return;
  await withCompany(e.companyId, () => deleteOptionMappings(e.payload.optionIds));
}
