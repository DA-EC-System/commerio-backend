// Cổng `fillProductFacts` (#497, Documents/21 §11.3; 25 §6.4 "Ghép listing có sẵn"): ghép SKU sàn điền trường dùng chung đang
// trống của sản phẩm. Trường đã có giá trị bỏ qua, không lỗi. Người làm là hệ thống, nhật ký kèm gian hàng nguồn.
import { requireCompanyId } from '../../../../shared/db/client.ts';
import { recordAudit } from '../../../core/index.ts';
import {
  lockProductFacts,
  lockVariantMeasures,
  type ProductFactsPatch,
  type VariantMeasuresPatch,
  writeProductFacts,
  writeVariantMeasures,
} from '../repository/product-facts.ts';
import { touchProduct } from '../repository/products.ts';
import { isUuid } from './errors.ts';

export interface VariantFacts {
  variantId: string;
  weightG: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
}

export interface ProductFacts {
  /** Mã ISO 3166-1 alpha-2. */
  originCountry?: string | null;
  brand?: string | null;
  description?: string | null;
  variants?: readonly VariantFacts[];
}

export interface FactsSource {
  shopId: string;
  /** Tên gian hàng lúc điền, ghi vào nhật ký để đọc được khi gian hàng đã xoá. */
  shopName?: string | null;
}

const MEASURES = ['weightG', 'lengthMm', 'widthMm', 'heightMm'] as const;
const COUNTRY = /^[A-Z]{2}$/;
const INT_MAX = 2_147_483_647;
const DESCRIPTION_MAX = 5000;
const BRAND_MAX = 100;

const text = (v: string | null | undefined) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const measure = (v: number | null | undefined) => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= INT_MAX ? v : null);

/**
 * Điền trường **đang trống** (Documents/21 §11.3): `originCountry`, `brand` null; `description` rỗng; cân nặng, kích thước của
 * SKU null (theo `variantId`, SKU không thuộc sản phẩm bỏ qua). Giá trị sàn không hợp luật của catalog (mã nước không phải 2
 * chữ, thương hiệu quá 100 ký tự, số không nguyên dương) thì bỏ, không cắt. Có trường được ghi thì tăng `version` (sản phẩm và
 * từng SKU được ghi), một dòng nhật ký mỗi bản ghi, `actorId` null, `after.source = { shopId, shopName }`. SKU ghi mà sản
 * phẩm không đổi thì chỉ đổi `updated_at` của sản phẩm (P7). Khoá SKU theo id rồi sản phẩm, cùng chiều sửa SKU. Trả tên trường
 * đã ghi (`variants.<variantId>.<trường>` cho SKU). Gọi trong `withCompany` của bên gọi.
 */
export async function fillProductFacts(productId: string, facts: ProductFacts, source: FactsSource): Promise<{ filled: string[] }> {
  const companyId = requireCompanyId('fillProductFacts');
  if (!isUuid(productId)) return { filled: [] };
  const filled: string[] = [];
  const auditSource = { shopId: source.shopId, shopName: source.shopName ?? null };
  const wanted = new Map((facts.variants ?? []).filter((v) => isUuid(v.variantId)).map((v) => [v.variantId, v]));
  const variants = await lockVariantMeasures(productId, [...wanted.keys()]);
  const product = await lockProductFacts(productId);
  if (!product) return { filled: [] };

  for (const row of variants) {
    const sent = wanted.get(row.id)!;
    const patch: VariantMeasuresPatch = {};
    for (const field of MEASURES) {
      const value = measure(sent[field]);
      if (row[field] === null && value !== null) patch[field] = value;
    }
    if (!Object.keys(patch).length) continue;
    await writeVariantMeasures(row.id, patch);
    filled.push(...Object.keys(patch).map((f) => `variants.${row.id}.${f}`));
    await recordAudit({
      companyId,
      actorId: null,
      action: 'update',
      entityType: 'product.product_variants',
      entityId: row.id,
      label: `${product.name} · ${row.sku}`,
      before: Object.fromEntries(Object.keys(patch).map((f) => [f, null])),
      after: { ...patch, source: auditSource },
    });
  }

  const patch: ProductFactsPatch = {};
  const origin = text(facts.originCountry)?.toUpperCase() ?? null;
  if (product.originCountry === null && origin && COUNTRY.test(origin)) patch.originCountry = origin;
  const brand = text(facts.brand);
  if (product.brand === null && brand && brand.length <= BRAND_MAX) patch.brand = brand;
  const description = text(facts.description);
  if (!text(product.description) && description && description.length <= DESCRIPTION_MAX) patch.description = description;
  if (Object.keys(patch).length) {
    await writeProductFacts(productId, patch);
    filled.push(...Object.keys(patch));
    await recordAudit({
      companyId,
      actorId: null,
      action: 'update',
      entityType: 'product.products',
      entityId: productId,
      label: product.name,
      before: Object.fromEntries(Object.keys(patch).map((f) => [f, f === 'description' ? product.description : null])),
      after: { ...patch, source: auditSource },
    });
  } else if (filled.length) {
    await touchProduct(productId);
  }
  return { filled };
}
