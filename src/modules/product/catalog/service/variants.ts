// Biến thể (UC-CP-02; Documents/21 5.2, 5.3, P5, P7, V23; plan #12 B2–B5, B8, B10, B11) và `getVariants`
// cho module khác (Documents/21 §11; chữ ký chốt ở plan chuẩn bị 4.5, không đổi).
import { requireCompanyId, withCompany } from '../../../../shared/db/client.ts';
import { recordAudit } from '../../../core/index.ts';
import { touchProduct } from '../repository/products.ts';
import { findVariants, insertVariant, lockVariants, setVariantArchived } from '../repository/variants.ts';
import { findCategories } from '../repository/categories.ts';
import { auditOf, type Caller, invalid, isUuid, lastVariant, notFound, pgError, productArchived, variantExists } from './errors.ts';
import { findOwnProduct, toVariantView } from './products.ts';
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
    archived: v.archivedAt !== null || v.productArchivedAt !== null,
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
 * Thêm biến thể (V23, P5, P7): tổ hợp đang bán → 409 `variant_exists`; từng ngừng bán → bán lại với SKU cũ (200);
 * mới → SKU mới (201). Không đổi `version` sản phẩm. Khoá công ty lấy trước khi đọc biến thể (B5).
 */
export async function addVariant(ctx: CatalogContext, caller: Caller, productId: string, attributeValueIds: string[]) {
  return withCompany(caller.companyId, async () => {
    await lockVariants(caller.companyId);
    const product = await findOwnProduct(productId);
    if (product.archivedAt) throw productArchived();
    const variants = await findVariants({ productId });
    const order = variants[0]?.attributes.map((a) => a.attributeId) ?? [];
    if (!order.length) throw badCombo('Sản phẩm tạo không có thuộc tính nên chỉ có một biến thể');
    const resolved = await resolveCombos([attributeValueIds], order);
    if (!resolved.ok) throw badCombo('Chọn đủ mỗi thuộc tính một giá trị');
    const combo = resolved.combos[0]!;

    const key = comboKey(combo.map((v) => v.id));
    const same = variants.find((v) => comboKey(v.attributes.map((a) => a.valueId)) === key);
    if (same && !same.archivedAt) throw variantExists(same.sku);
    let id: string;
    if (same) {
      // Từng ngừng bán: bán lại với SKU cũ, không cấp SKU mới (P5).
      id = same.id;
      await setVariantArchived(id, false);
    } else {
      const [category] = await findCategories(product.categoryId);
      const [sku] = await allocateSkus(category!, [combo]);
      id = await insertVariant(caller.companyId, productId, sku!, combo.map((v) => v.id), 0);
    }
    await touchProduct(productId);
    const [variant] = await findVariants({ ids: [id] });
    const after = variantSnapshot(product.name, variant!);
    await recordAudit(
      same
        ? {
            ...auditOf(caller, 'update', ENTITY, id),
            before: { ...after, archivedAt: same.archivedAt!.toISOString() },
            after: { ...after, archivedAt: null },
          }
        : { ...auditOf(caller, 'create', ENTITY, id), after },
    );
    const prices = await standardPricesOf(ctx, [id]);
    return { created: !same, variant: toVariantView(variant!, prices.get(id) ?? null) };
  }).catch((err: unknown) => {
    // Giá trị thuộc tính vừa bị xoá giữa lúc đọc và lúc chèn.
    if (pgError(err).code === '23503') throw badCombo('Có giá trị thuộc tính vừa bị xoá');
    throw err;
  });
}

/** Ngừng bán (P5): SKU giữ nguyên, không cấp lại; phải còn ít nhất một biến thể đang bán. */
export async function archiveVariant(caller: Caller, productId: string, variantId: string): Promise<void> {
  await withCompany(caller.companyId, async () => {
    await lockVariants(caller.companyId);
    const product = await findOwnProduct(productId);
    if (product.archivedAt) throw productArchived();
    const variants = await findVariants({ productId });
    const variant = variants.find((v) => v.id === variantId && !v.archivedAt);
    if (!variant) throw notFound('biến thể đang bán');
    if (variants.filter((v) => !v.archivedAt).length === 1) throw lastVariant();
    await setVariantArchived(variantId, true);
    await touchProduct(productId);
    await recordAudit({ ...auditOf(caller, 'delete', ENTITY, variantId), before: variantSnapshot(product.name, variant) });
  });
}
