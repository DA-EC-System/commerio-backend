import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import type { SuggestColumns } from './groups.ts';
import { companyProductSettings } from './schema.ts';

// Chạy trong `withCompany`: RLS chỉ cho thấy dòng của công ty đang chọn (mỗi công ty đúng một dòng).

const columns = {
  skuPattern: companyProductSettings.skuPattern,
  skuNextSeq: companyProductSettings.skuNextSeq,
  marginCoefficient: companyProductSettings.marginCoefficient,
  priceRounding: companyProductSettings.priceRounding,
  reorderLeadDays: companyProductSettings.reorderLeadDays,
  reorderSafetyQty: companyProductSettings.reorderSafetyQty,
  reorderDefaultQty: companyProductSettings.reorderDefaultQty,
  version: companyProductSettings.version,
};

export type SettingsRow = Awaited<ReturnType<typeof findSettings>>;

/** Dòng cài đặt của công ty đang chọn; thiếu là lỗi dữ liệu (tạo cùng công ty, `seedCompanyDefaults`). */
export async function findSettings() {
  const [row] = await getDb().select(columns).from(companyProductSettings);
  if (!row) throw new Error('Công ty chưa có cài đặt sản phẩm (chạy lại migration *_nhom-hang-du-lieu)');
  return row;
}

export async function updateSettingsIfVersion(companyId: string, version: number, skuPattern: string, suggest: SuggestColumns) {
  const rows = await getDb()
    .update(companyProductSettings)
    .set({ skuPattern, ...suggest, version: sql`${companyProductSettings.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(companyProductSettings.companyId, companyId), eq(companyProductSettings.version, version)))
    .returning({ companyId: companyProductSettings.companyId });
  return rows.length > 0;
}

/** Số {SEQ} kế tiếp sau khi cấp SKU; không đổi `version` (Documents/21 P7). Gọi sau `lockVariants`. */
export async function setSkuNextSeq(companyId: string, next: number): Promise<void> {
  await getDb().update(companyProductSettings).set({ skuNextSeq: next }).where(eq(companyProductSettings.companyId, companyId));
}
