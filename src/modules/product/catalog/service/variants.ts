// Biến thể (UC-CP-02; Documents/21 5.2, 5.3, P5, P7, V23; plan #12 B2–B5, B8, B10, B11), sửa một SKU (#204, §17.2)
// và `getVariants` cho module khác (Documents/21 §11; chữ ký chốt ở plan chuẩn bị 4.5, chỉ thêm trường).
import { Decimal } from 'decimal.js';
import { requireCompanyId, withCompany } from '../../../../shared/db/client.ts';
import { publishEvent, recordAudit } from '../../../core/index.ts';
import { touchProduct } from '../repository/products.ts';
import {
  findVariants,
  insertVariant,
  lockVariants,
  updateVariantIfVersion,
  type VariantPatch,
  type VariantRow,
} from '../repository/variants.ts';
import { findCategories } from '../repository/categories.ts';
import {
  auditOf,
  type Caller,
  invalid,
  isUuid,
  notFound,
  pgError,
  variantArchived,
  variantExists,
  versionConflict,
} from './errors.ts';
import { findOwnProduct, type ProductDetail, productDetail, toDong, toVariantView } from './products.ts';
import { allocateSkus, comboKey, resolveCombos } from './sku-allocation.ts';
import { type CatalogContext, standardPricesOf } from './standard-price.ts';

/** Biến thể kèm sản phẩm, danh mục và giá trị thuộc tính (theo `position`) cho inventory, pricing, sales, channel. */
export interface VariantSummary {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  categoryId: string;
  categoryName: string;
  /** Không còn bán: biến thể ngừng bán **hoặc** sản phẩm đã lưu trữ (plan #12 B10). */
  archived: boolean;
  /** Trạng thái kinh doanh của SKU; nhập được khi `selling` hoặc `paused` (FE `purchasable`). */
  businessStatus: 'selling' | 'paused' | 'discontinued' | 'archived';
  /** Mô tả của sản phẩm cha (#204: channel đẩy lên sàn). */
  description: string | null;
  /** Cân nặng (g) và kích thước gói (mm); sàn dùng để tính phí ship (#204). `null` khi chưa nhập. */
  weightG: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  attributes: { attributeId: string; attributeName: string; valueId: string; value: string; code: string }[];
}

/**
 * Bỏ trống `ids` = mọi biến thể của công ty (D10 lọc trong bộ nhớ). Id không thấy (RLS, không tồn tại, không phải
 * uuid) thì không có trong kết quả. Gọi trong `withCompany` của bên gọi.
 */
export async function getVariants(ids?: readonly string[]): Promise<VariantSummary[]> {
  // Ngoài `withCompany` (role chủ bảng) RLS không có hiệu lực: hàm sẽ trả biến thể của mọi công ty.
  requireCompanyId('getVariants');
  const rows = await findVariants(ids ? { ids: ids.filter(isUuid) } : {});
  return rows.map((v) => ({
    id: v.id,
    productId: v.productId,
    productName: v.productName,
    sku: v.sku,
    categoryId: v.categoryId,
    categoryName: v.categoryName,
    archived: v.businessStatus === 'archived',
    businessStatus: v.businessStatus,
    description: v.description,
    weightG: v.weightG,
    lengthMm: v.lengthMm,
    widthMm: v.widthMm,
    heightMm: v.heightMm,
    attributes: v.attributes,
  }));
}

const ENTITY = 'product.product_variants';
const badCombo = (message: string) => invalid({ attributeValueIds: message });
const variantSnapshot = (productName: string, v: { sku: string; attributes: { value: string }[] }) => ({
  product: productName,
  sku: v.sku,
  attributes: v.attributes.map((a) => a.value),
});

/**
 * Thêm biến thể (V23, P5, P7): tổ hợp của SKU chưa lưu trữ → 409 `variant_exists`; của SKU đã lưu trữ → 409
 * `variant_archived` kèm `variantId` (dùng Khôi phục, không bán lại ngầm; Documents/21 §17.2, #204); mới → SKU mới.
 * Không đổi `version` sản phẩm. Khoá công ty lấy trước khi đọc biến thể (B5).
 */
export async function addVariant(ctx: CatalogContext, caller: Caller, productId: string, attributeValueIds: string[]) {
  return withCompany(caller.companyId, async () => {
    await lockVariants(caller.companyId);
    const product = await findOwnProduct(productId);
    const variants = await findVariants({ productId });
    const order = variants[0]?.attributes.map((a) => a.attributeId) ?? [];
    if (!order.length) throw badCombo('Sản phẩm tạo không có thuộc tính nên chỉ có một biến thể');
    const resolved = await resolveCombos([attributeValueIds], order);
    if (!resolved.ok) throw badCombo('Chọn đủ mỗi thuộc tính một giá trị');
    const combo = resolved.combos[0]!;

    const key = comboKey(combo.map((v) => v.id));
    const same = variants.find((v) => comboKey(v.attributes.map((a) => a.valueId)) === key);
    if (same?.businessStatus === 'archived') throw variantArchived(same.id);
    if (same) throw variantExists(same.sku);
    const [category] = await findCategories(product.categoryId);
    const [allocated] = await allocateSkus(category!, [combo]);
    const id = await insertVariant(caller.companyId, productId, allocated!.sku, combo.map((v) => v.id), 0);
    await touchProduct(productId);
    const [variant] = await findVariants({ ids: [id] });
    await recordAudit({ ...auditOf(caller, 'create', ENTITY, id), after: variantSnapshot(product.name, variant!) });
    const prices = await standardPricesOf(ctx, [id]);
    return toVariantView(variant!, prices.get(id) ?? null);
  }).catch((err: unknown) => {
    // Giá trị thuộc tính vừa bị xoá giữa lúc đọc và lúc chèn.
    if (pgError(err).code === '23503') throw badCombo('Có giá trị thuộc tính vừa bị xoá');
    throw err;
  });
}

/** Thân của PATCH SKU (Documents/21 §17.2); số nguyên đồng, gam, mm. Bỏ trường là giữ, `null` là xoá. */
export interface UpdateVariantInput {
  version: number;
  standardPrice?: number | null | undefined;
  targetNetPrice?: number | null | undefined;
  weightG?: number | null | undefined;
  lengthMm?: number | null | undefined;
  widthMm?: number | null | undefined;
  heightMm?: number | null | undefined;
}

/** `unchanged`: không trường nào khác hiện tại, không ghi. `stale`: `version` không còn đúng, không ghi. */
export type VariantUpdateOutcome = 'unchanged' | 'updated' | 'stale';

const PRICE_FIELDS = ['standardPrice', 'targetNetPrice'] as const;
const MEASURE_FIELDS = ['weightG', 'lengthMm', 'widthMm', 'heightMm'] as const;

/** Giá đang lưu (chuỗi `numeric`) và giá gửi lên (số đồng) có bằng nhau không; `null` chỉ bằng `null`. */
const samePrice = (stored: string | null, sent: number | null) =>
  stored === null || sent === null ? stored === sent : new Decimal(stored).eq(sent);

/**
 * Sửa một SKU trong giao dịch `withCompany` của bên gọi (PATCH ở đây, sửa hàng loạt #242 gọi cho từng dòng). Chỉ ghi
 * trường khác hiện tại; không trường nào khác thì không ghi và không kiểm `version` (gửi lại PATCH đã thành công vẫn
 * 200). Ghi được thì tăng `version` SKU và ghi nhật ký chỉ gồm trường đổi, theo dạng API.
 *
 * Bên gọi tự: kiểm sản phẩm chưa lưu trữ và SKU thuộc sản phẩm; gọi `touchProduct` **một lần mỗi sản phẩm, sau mọi
 * SKU** (đổi `updated_at` cha, P7). Hàm này không chạm dòng sản phẩm, để giao dịch sửa nhiều SKU khoá theo thứ tự
 * SKU → sản phẩm như thêm, ngừng bán biến thể, không deadlock với PATCH đơn lẻ.
 */
export async function applyVariantUpdate(
  caller: Caller,
  current: VariantRow,
  input: UpdateVariantInput,
): Promise<VariantUpdateOutcome> {
  const patch: VariantPatch = {};
  const before: Record<string, number | null> = {};
  const after: Record<string, number | null> = {};
  for (const field of PRICE_FIELDS) {
    const sent = input[field];
    if (sent === undefined || samePrice(current[field], sent)) continue;
    patch[field] = sent === null ? null : String(sent);
    before[field] = toDong(current[field]);
    after[field] = sent;
  }
  for (const field of MEASURE_FIELDS) {
    const sent = input[field];
    if (sent === undefined || sent === current[field]) continue;
    patch[field] = sent;
    before[field] = current[field];
    after[field] = sent;
  }
  if (!Object.keys(patch).length) return 'unchanged';
  // So trước trong JS: phần chênh và `from` của sự kiện tính từ đúng bản `version` này, và số `version` vượt `integer`
  // không tới được câu SQL (lỗi 22003 thành 500, làm hỏng cả giao dịch sửa hàng loạt).
  if (input.version !== current.version) return 'stale';

  const updated = await updateVariantIfVersion(current.id, input.version, patch);
  if (!updated) return 'stale';
  await recordAudit({ ...auditOf(caller, 'update', ENTITY, current.id), before, after });
  // Giá muốn bán đổi: channel chạy lại bộ lọc giá (#225). Câu UPDATE trên đã khoá dòng SKU, nên sự kiện của một SKU
  // vào outbox đúng thứ tự. Giá chuẩn đổi không phát (Documents/21 §11.2).
  if ('targetNetPrice' in patch) {
    await publishEvent({
      type: 'catalog.variant_price_changed',
      aggregateId: current.id,
      payload: {
        variantId: current.id,
        productId: current.productId,
        from: current.targetNetPrice,
        to: updated.targetNetPrice,
        changedAt: updated.updatedAt.toISOString(),
      },
    });
  }
  return 'updated';
}

/**
 * `PATCH /catalog/products/:id/variants/:variantId` (#204). SKU đã ngừng nhập, đã lưu trữ vẫn sửa được (điền cho đủ
 * trước khi khôi phục).
 */
export async function updateVariant(
  ctx: CatalogContext,
  caller: Caller,
  productId: string,
  variantId: string,
  input: UpdateVariantInput,
): Promise<ProductDetail> {
  return withCompany(caller.companyId, async () => {
    const product = await findOwnProduct(productId);
    const [current] = isUuid(variantId) ? await findVariants({ ids: [variantId] }) : [];
    if (!current || current.productId !== product.id) throw notFound('biến thể');
    const outcome = await applyVariantUpdate(caller, current, input);
    if (outcome === 'updated') await touchProduct(product.id);
    if (outcome === 'stale') {
      throw versionConflict(`SKU ${current.sku} vừa được người khác sửa`, await productDetail(ctx, await findOwnProduct(productId)));
    }
    return productDetail(ctx, await findOwnProduct(productId));
  });
}
