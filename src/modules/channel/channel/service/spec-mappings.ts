// Trang ánh xạ thông số sang sàn (#509, Documents/21 §18.8.1): đọc kèm gợi ý tính lúc đọc, thay tập mã của một thông số, tìm
// attribute đã gặp của sàn. Không gọi sàn: chỉ đọc `platform_category_attributes` đã lấy.
import { type EventEnvelope, type EventPayload, recordAudit } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import type { ModuleContext } from '../../../../shared/module.ts';
import { type AttributeKind, normalizePath } from '../domain/product-spec.ts';
import type { Marketplace } from '../repository/schema.ts';
import type { FieldMapping } from '../domain/spec-resolve.ts';
import {
  attributesByCodes,
  type CatalogAttribute,
  codesTakenByOthers,
  deleteFieldMappings,
  deleteOptionMappings,
  mappingsOf,
  propertyAttributesOf,
  replaceCompanyOptionMappings,
  replaceFieldMapping,
  searchAttributeCatalog,
} from '../repository/spec-mappings.ts';
import { getAdapter } from './marketplaces/index.ts';
import { type DataScope, productPort, type SpecFieldInfo } from './product-port.ts';
import { platformOf } from './shops.ts';

interface MappingOption {
  optionId: string;
  platformOptionId: string | null;
  platformLabel: string | null;
  scope: DataScope;
  editable: boolean;
}
export interface SpecMapping {
  fieldId: string;
  /** `platform`: thông số chuẩn, mã do nền tảng giữ (chỉ đọc với công ty); lựa chọn riêng vẫn `editable`. */
  scope: DataScope;
  editable: boolean;
  codes: { attributeCode: string; attributeLabel: string; priority: number; options: MappingOption[] }[];
  suggestions: { attributeCode: string; attributeLabel: string; options: MappingOption[] }[];
}

const hasOptions = (f: SpecFieldInfo) => f.input === 'select' || f.input === 'multiselect';
const scopeOf = (x: { scope?: DataScope }): DataScope => x.scope ?? 'company';

/** Lựa chọn của thông số kèm lựa chọn sàn đã ánh xạ (`known`), hoặc ghép theo nhãn khi gợi ý (`byLabel`). */
function optionRows(field: SpecFieldInfo, attr: CatalogAttribute | undefined, known: ReadonlyMap<string, string> | null): MappingOption[] {
  if (!hasOptions(field)) return [];
  const label = new Map((attr?.options ?? []).map((o) => [o.id, o.label]));
  const byLabel = new Map((attr?.options ?? []).map((o) => [normalizePath(o.label), o.id]));
  return [...field.options]
    .sort((a, b) => a.position - b.position)
    .map((o) => {
      const id = known ? (known.get(o.id) ?? null) : (byLabel.get(normalizePath(o.value)) ?? null);
      const scope = scopeOf(o);
      return { optionId: o.id, platformOptionId: id, platformLabel: id === null ? null : (label.get(id) ?? null), scope, editable: scope === 'company' };
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
    const scope = scopeOf(field);
    return {
      fieldId: field.id,
      scope,
      editable: scope === 'company',
      codes: own.map((m) => ({
        attributeCode: m.attributeCode,
        attributeLabel: attrs.get(m.attributeCode)?.label ?? m.attributeCode,
        priority: m.priority,
        options: optionRows(field, attrs.get(m.attributeCode), m.options),
      })),
      // Gợi ý tính lúc đọc, không lưu (§18.8.1): attribute property trùng tên thông số, mã chưa ánh xạ cho thông số nào.
      // Thông số chuẩn thì không gợi ý: công ty không đổi được mã.
      suggestions: properties
        .filter((a) => scope === 'company' && !taken.has(a.code) && normalizePath(a.label) === name)
        .map((a) => ({ attributeCode: a.code, attributeLabel: a.label, options: optionRows(field, a, null) })),
    };
  });
}

/**
 * Attribute theo mã: cache `platform_category_attributes` trước; mã của ánh xạ mặc định mà cache chưa có leaf nào chứa thì lấy
 * nhãn adapter khai (`defaultAttributeLabels`), kiểu `property`, chưa có lựa chọn. Không có bước này, trang ánh xạ hiện mã thay
 * nhãn và `PUT` lại ánh xạ mặc định bị 422 "không phải thuộc tính đã gặp" cho tới khi đồng bộ đúng leaf.
 */
async function knownAttributes(platform: Marketplace, codes: readonly string[]): Promise<Map<string, CatalogAttribute>> {
  const attrs = await attributesByCodes(platform, codes);
  const labels = getAdapter(platform)?.defaultAttributeLabels ?? {};
  for (const code of codes) {
    const label = labels[code];
    if (!attrs.has(code) && label) attrs.set(code, { code, label, kind: 'property', input: 'text', options: [] });
  }
  return attrs;
}

/** `GET /channel/platforms/:platform/spec-mappings`: mỗi thông số của công ty một dòng. */
export async function listSpecMappings(ctx: ModuleContext, companyId: string, raw: string): Promise<{ items: SpecMapping[] }> {
  const { platform } = platformOf(raw);
  return withCompany(companyId, async () => {
    const fields = (await productPort(ctx).specFields?.()) ?? [];
    const mappings = await mappingsOf(platform);
    const attrs = await knownAttributes(platform, mappings.map((m) => m.attributeCode));
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
    if (scopeOf(field) === 'platform') return putStandardFieldOptions(actor, platform, field, input, adapter.name);
    const codes = input.codes.map((c) => c.attributeCode);
    const attrs = await knownAttributes(platform, codes);
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

/**
 * PUT lên thông số chuẩn (chốt 3, contract dữ liệu chung mục F): tập mã phải giữ đúng như nền tảng (đổi thì 403
 * `platform_managed`), lựa chọn chuẩn cũng vậy; chỉ ánh xạ lựa chọn riêng của công ty được thay.
 */
async function putStandardFieldOptions(
  actor: { companyId: string; accountId: string },
  platform: Marketplace,
  field: SpecFieldInfo,
  input: SpecMappingInput,
  platformName: string,
): Promise<SpecMapping> {
  const managed = () => new AppError(403, 'platform_managed', 'Ánh xạ của thông số chuẩn do nền tảng quản lý, công ty chỉ ánh xạ được lựa chọn riêng');
  const current = (await mappingsOf(platform, [field.id])).sort((a, b) => a.priority - b.priority);
  const codes = input.codes.map((c) => c.attributeCode);
  if (codes.length !== current.length || codes.some((c, i) => c !== current[i]!.attributeCode)) throw managed();
  const scopes = new Map(field.options.map((o) => [o.id, scopeOf(o)]));
  const attrs = await knownAttributes(platform, codes);
  const errors: Record<string, string> = {};
  const own: { optionId: string; attributeCode: string; platformOptionId: string }[] = [];
  input.codes.forEach((c, i) => {
    const known = current[i]!.options;
    const platformIds = new Set((attrs.get(c.attributeCode)?.options ?? []).map((o) => o.id));
    (c.options ?? []).forEach((o, j) => {
      const scope = scopes.get(o.optionId);
      if (!scope) errors[`codes.${i}.options.${j}`] = 'Không phải lựa chọn của thông số';
      else if (scope === 'platform') {
        if ((known.get(o.optionId) ?? null) !== o.platformOptionId) throw managed();
      } else if (o.platformOptionId !== null) {
        if (!platformIds.has(o.platformOptionId)) errors[`codes.${i}.options.${j}`] = 'Không có trong lựa chọn của thuộc tính trên sàn';
        else own.push({ optionId: o.optionId, attributeCode: c.attributeCode, platformOptionId: o.platformOptionId });
      }
    });
  });
  if (Object.keys(errors).length) throw new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', { errors });
  const before = current.flatMap((m) => [...m.options].filter(([id]) => scopes.get(id) === 'company').map(([optionId, v]) => ({ optionId, attributeCode: m.attributeCode, platformOptionId: v })));
  await replaceCompanyOptionMappings(actor.companyId, platform, field.id, own);
  await recordAudit({
    companyId: actor.companyId,
    actorId: actor.accountId,
    action: 'update',
    entityType: 'channel.spec_option_mappings',
    entityId: field.id,
    label: `${field.name} · ${platformName}`,
    before: { options: before },
    after: { options: own },
  });
  const [item] = toMappings([field], await mappingsOf(platform), attrs, []);
  return item!;
}

/** `GET /channel/platforms/:platform/attribute-catalog`: attribute đã gặp ở các leaf đã lấy, gộp theo mã. */
export async function attributeCatalog(raw: string, search: string, kind: AttributeKind | undefined) {
  const { platform } = platformOf(raw);
  return { items: await searchAttributeCatalog(platform, search.trim(), kind) };
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
