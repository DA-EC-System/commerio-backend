// Ánh xạ trục phân loại sang sales attribute của sàn (#448, Documents/21 §18.8.1, §18.8.3 nguồn 2). Hai tầng: thuộc tính chuẩn
// có ánh xạ nền tảng (`company_id` NULL, chỉ migration ghi), thuộc tính riêng có ánh xạ của công ty.
import { recordAudit } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import type { ModuleContext } from '../../../../shared/module.ts';
import { axisCodesOf, replaceAxisCodes } from '../repository/axis-mappings.ts';
import { salesLabelsOf } from '../repository/platform-categories.ts';
import type { Marketplace } from '../repository/schema.ts';
import { type DataScope, productPort } from './product-port.ts';
import type { PlatformKind } from '../domain/product-spec.ts';
import { platformOf } from './shops.ts';

export interface AxisMappingItem {
  attributeId: string;
  platformKind: PlatformKind | null;
  /** `platform`: thuộc tính chuẩn, ánh xạ do nền tảng giữ, chỉ đọc với công ty (dữ liệu chung, chốt 3). */
  scope: DataScope;
  editable: boolean;
  codes: { attributeCode: string; attributeLabel: string | null; priority: number }[];
  defaultCodes: string[];
}

async function companyAttributes(ctx: ModuleContext) {
  return (await productPort(ctx).attributes?.()) ?? [];
}

function itemOf(
  attr: { id: string; platformKind: AxisMappingItem['platformKind']; scope?: DataScope },
  codes: readonly string[],
  labels: ReadonlyMap<string, string>,
  standard: Partial<Record<NonNullable<AxisMappingItem['platformKind']>, readonly string[]>>,
): AxisMappingItem {
  return {
    attributeId: attr.id,
    platformKind: attr.platformKind,
    scope: attr.scope ?? 'company',
    editable: (attr.scope ?? 'company') === 'company',
    codes: codes.map((attributeCode, i) => ({ attributeCode, attributeLabel: labels.get(attributeCode) ?? null, priority: i + 1 })),
    defaultCodes: attr.platformKind ? [...(standard[attr.platformKind] ?? [])] : [],
  };
}

/** Mỗi thuộc tính phân loại của công ty một dòng; dòng ánh xạ của thuộc tính không còn thì bỏ qua. */
export async function listAxisMappings(ctx: ModuleContext, companyId: string, rawPlatform: string): Promise<{ items: AxisMappingItem[] }> {
  const { platform, adapter } = platformOf(rawPlatform);
  return withCompany(companyId, async () => {
    const [attributes, codes, labels] = await Promise.all([companyAttributes(ctx), axisCodesOf(platform), salesLabelsOf(platform)]);
    return { items: attributes.map((a) => itemOf(a, codes.get(a.id) ?? [], labels, adapter.standardSalesAttributes ?? {})) };
  });
}

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** Thay danh sách mã của một thuộc tính: 404 thuộc tính không phải của công ty; 422 mã trùng hoặc không phải sales attribute đã gặp. */
export async function putAxisMapping(
  ctx: ModuleContext,
  actor: { companyId: string; accountId: string },
  rawPlatform: string,
  attributeId: string,
  codes: readonly string[],
): Promise<AxisMappingItem> {
  const { platform, adapter } = platformOf(rawPlatform);
  return withCompany(actor.companyId, async () => {
    const attr = isUuid(attributeId) ? (await companyAttributes(ctx)).find((a) => a.id === attributeId) : undefined;
    if (!attr) throw new AppError(404, 'not_found', 'Không tìm thấy thuộc tính');
    if (attr.scope === 'platform') {
      throw new AppError(403, 'platform_managed', 'Ánh xạ của thuộc tính chuẩn do nền tảng quản lý, công ty chỉ ánh xạ thuộc tính riêng');
    }
    const labels = await salesLabelsOf(platform);
    const errors: Record<string, string> = {};
    const seen = new Set<string>();
    codes.forEach((code, i) => {
      if (seen.has(code)) errors[`codes.${i}.attributeCode`] = 'Mã bị trùng trong danh sách';
      else if (!labels.has(code)) errors[`codes.${i}.attributeCode`] = 'Không phải thuộc tính phân loại (sales attribute) nào của sàn đã gặp';
      seen.add(code);
    });
    if (Object.keys(errors).length) throw new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', { errors });
    const before = (await axisCodesOf(platform)).get(attributeId) ?? [];
    await replaceAxisCodes(actor.companyId, attributeId, platform as Marketplace, codes);
    await recordAudit({
      companyId: actor.companyId,
      actorId: actor.accountId,
      action: 'update',
      entityType: 'channel.axis_mappings',
      entityId: attributeId,
      label: `${attr.name} · ${platform}`,
      before: { codes: before },
      after: { codes: [...codes] },
    });
    return itemOf(attr, codes, labels, adapter.standardSalesAttributes ?? {});
  });
}
