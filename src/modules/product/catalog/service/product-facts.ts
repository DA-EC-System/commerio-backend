// Cổng `fillProductFacts` (#497, Documents/21 §11.3; 25 §6.4 "Ghép listing có sẵn"): ghép SKU sàn điền trường dùng chung đang
// trống của sản phẩm. Trường đã có giá trị bỏ qua, không lỗi. Người làm là hệ thống, nhật ký kèm gian hàng nguồn.
import { requireCompanyId } from '../../../../shared/db/client.ts';
import { fileProblem, recordAudit } from '../../../core/index.ts';
import { EDGE_MAX_MM, WEIGHT_MAX_G } from '../domain/measure.ts';
import {
  lockProductFacts,
  lockVariantMeasures,
  type ProductFactsPatch,
  type VariantMeasuresPatch,
  writeProductFacts,
  writeVariantMeasures,
} from '../repository/product-facts.ts';
import { productImageRows, replaceProductImages } from '../repository/product-images.ts';
import { sizeChartRows, touchProduct } from '../repository/products.ts';
import { isUuid } from './errors.ts';
import { MAX_PRODUCT_IMAGES } from './product-images.ts';
import { fillEmptySpecs } from './product-specs.ts';

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
  /** Tệp `product_image` đã tải từ sàn (`ingestRemoteImage` của core), theo thứ tự ảnh sàn; chỉ gắn khi sản phẩm chưa có ảnh nào (#498). */
  imageFileIds?: readonly string[];
  /** Tệp `product_image` của ảnh bảng size trên sàn; chỉ gắn khi sản phẩm chưa có (#498). */
  sizeChartFileId?: string | null;
  /**
   * Thông số (#510, Documents/21 mục 11.3, 18.8.2): channel đã đổi mã sàn sang lựa chọn qua ánh xạ. Chỉ ghi thông số đang
   * trống; lựa chọn lạ, giá trị sai luật thì bỏ; không tạo lựa chọn mới. Tên trường `specs.<code>`.
   */
  specs?: readonly { fieldId: string; optionIds?: string[]; value?: string }[];
}

export interface FactsSource {
  shopId: string;
  /** Tên gian hàng lúc điền, ghi vào nhật ký để đọc được khi gian hàng đã xoá. */
  shopName?: string | null;
}

// Trần như mọi đường ghi SKU (#434): vượt trần thì bỏ, không để CHECK `product_variants_dimensions` làm hỏng cả lần ghép.
const MEASURES = [
  ['weightG', WEIGHT_MAX_G],
  ['lengthMm', EDGE_MAX_MM],
  ['widthMm', EDGE_MAX_MM],
  ['heightMm', EDGE_MAX_MM],
] as const;
const COUNTRY = /^[A-Z]{2}$/;
const DESCRIPTION_MAX = 5000;
const BRAND_MAX = 100;

const text = (v: string | null | undefined) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const measure = (v: number | null | undefined, max: number) => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= max ? v : null);

/**
 * Điền trường **đang trống** (Documents/21 §11.3): `originCountry`, `brand` null; `description` rỗng; cân nặng, kích thước của
 * SKU null (theo `variantId`, SKU không thuộc sản phẩm bỏ qua). Giá trị sàn không hợp luật của catalog (mã nước không phải 2
 * chữ, thương hiệu quá 100 ký tự, số không nguyên dương hoặc vượt trần 50.000 g / 2.000 mm của #434) thì bỏ, không cắt.
 * Có trường được ghi thì tăng `version` (sản phẩm và từng SKU được ghi), một dòng nhật ký mỗi bản ghi, `actorId` null,
 * `after.source = { shopId, shopName }`. SKU ghi mà sản phẩm không đổi thì chỉ đổi `updated_at` của sản phẩm (P7). Khoá SKU theo id rồi sản phẩm, cùng chiều sửa SKU. Trả tên trường
 * đã ghi (`variants.<variantId>.<trường>` cho SKU). Ảnh (#498): sản phẩm chưa có ảnh nào thì gắn `imageFileIds` (tối đa 9, bỏ
 * id trùng và tệp không dùng được theo `fileProblem`), chưa có bảng size thì gắn `sizeChartFileId`; tên trường `images`,
 * `sizeChartFileId`. Gọi trong `withCompany` của bên gọi.
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
    for (const [field, max] of MEASURES) {
      const value = measure(sent[field], max);
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
  if (product.sizeChartFileId === null && facts.sizeChartFileId && (await usableImages([facts.sizeChartFileId])).length) {
    patch.sizeChartFileId = facts.sizeChartFileId;
  }
  const images = facts.imageFileIds?.length && !(await productImageRows([productId], 1)).length ? await usableImages(facts.imageFileIds) : [];
  if (images.length) await replaceProductImages(companyId, productId, images);
  const specs = facts.specs?.length ? await fillEmptySpecs(companyId, productId, facts.specs) : { filled: [], after: {} };
  if (Object.keys(patch).length || images.length || specs.filled.length) {
    await writeProductFacts(productId, patch);
    filled.push(...Object.keys(patch), ...(images.length ? ['images'] : []), ...specs.filled);
    await recordAudit({
      companyId,
      actorId: null,
      action: 'update',
      entityType: 'product.products',
      entityId: productId,
      label: product.name,
      before: {
        ...Object.fromEntries(Object.keys(patch).map((f) => [f, f === 'description' ? product.description : null])),
        ...(images.length ? { images: [] } : {}),
        ...(specs.filled.length ? { specs: Object.fromEntries(Object.keys(specs.after).map((c) => [c, null])) } : {}),
      },
      after: { ...patch, ...(images.length ? { images } : {}), ...(specs.filled.length ? { specs: specs.after } : {}), source: auditSource },
    });
  } else if (filled.length) {
    await touchProduct(productId);
  }
  return { filled };
}

/** Tệp dùng được làm ảnh sản phẩm, giữ thứ tự, bỏ trùng, tối đa 9; xét từng tệp để một tệp hỏng không làm mất cả bộ. */
async function usableImages(fileIds: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of new Set(fileIds)) {
    if (out.length >= MAX_PRODUCT_IMAGES) break;
    if (!(await fileProblem([id], 'product_image', 1))) out.push(id);
  }
  return out;
}

/** Sản phẩm thiếu ảnh, thiếu bảng size (#498): channel hỏi trước khi tải ảnh sàn. Id không có ảnh coi là thiếu. Gọi trong `withCompany`. */
export async function productMediaGaps(productIds: readonly string[]): Promise<Map<string, { images: boolean; sizeChart: boolean }>> {
  const withImages = new Set((await productImageRows(productIds, 1)).map((r) => r.productId));
  const withChart = new Set((await sizeChartRows(productIds)).map((r) => r.productId));
  return new Map(productIds.map((id) => [id, { images: !withImages.has(id), sizeChart: !withChart.has(id) }]));
}
