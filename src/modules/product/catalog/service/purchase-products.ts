// Sản phẩm mới từ đề nghị nhập (#108, Documents/25 §3.2): purchasing kiểm khi lập, tạo khi CEO duyệt.
// Chạy trong `withCompany` của bên gọi, không tự mở giao dịch (withCompany không lồng được).
import { recordAudit } from '../../../core/index.ts';
import { findCategories } from '../repository/categories.ts';
import { insertProduct, productNameExists } from '../repository/products.ts';
import { insertVariant, lockVariants } from '../repository/variants.ts';
import { allocateSkus } from './sku-allocation.ts';

export interface NewProductItem {
  name: string;
  categoryId: string;
}

/** Lỗi theo chỉ số mục: trường nào sai và câu báo. Rỗng là hợp lệ. */
export type NewProductErrors = Map<number, { field: 'name' | 'categoryId'; message: string }>;

/** Danh mục có thật trong công ty, tên chưa có sản phẩm nào dùng (chữ thường), các mục không trùng tên nhau. */
export async function validateNewProducts(items: readonly NewProductItem[]): Promise<NewProductErrors> {
  const errors: NewProductErrors = new Map();
  const names = categoryNamesOf(await findCategories());
  const seen = new Set<string>();
  for (const [i, item] of items.entries()) {
    const key = item.name.toLowerCase();
    if (!names.has(item.categoryId)) errors.set(i, { field: 'categoryId', message: 'Chọn danh mục' });
    else if (seen.has(key)) errors.set(i, { field: 'name', message: 'Sản phẩm mới bị lặp' });
    else if (await productNameExists(item.name)) errors.set(i, { field: 'name', message: 'Đã có sản phẩm cùng tên' });
    seen.add(key);
  }
  return errors;
}

/**
 * Mỗi mục một sản phẩm với một biến thể không thuộc tính, SKU theo quy tắc của danh mục. Trả `variantId` đúng thứ tự
 * mục. Khoá công ty của catalog trước khi kiểm lại, nên hai giao dịch không cùng tạo một tên. Mục sai thì trả lỗi,
 * không tạo gì; bên gọi ném lỗi để rollback.
 */
export async function createPurchaseProducts(
  caller: { companyId: string; accountId: string },
  items: readonly NewProductItem[],
  description: string,
): Promise<{ ok: true; variantIds: string[] } | { ok: false; errors: NewProductErrors }> {
  await lockVariants(caller.companyId);
  const errors = await validateNewProducts(items);
  if (errors.size) return { ok: false, errors };
  const categories = new Map((await findCategories()).map((c) => [c.id, c]));
  const variantIds: string[] = [];
  for (const item of items) {
    // Cấp SKU từng mục: `sku_next_seq` của danh mục vừa tăng, đọc lại trước mục kế tiếp cùng danh mục.
    const [category] = await findCategories(item.categoryId);
    const productId = await insertProduct(caller.companyId, item.categoryId, item.name, description);
    const [sku] = await allocateSkus(category!, [[]]);
    const variantId = await insertVariant(caller.companyId, productId, sku!, [], 0);
    variantIds.push(variantId);
    await recordAudit({
      companyId: caller.companyId,
      actorId: caller.accountId,
      action: 'create',
      entityType: 'product.products',
      entityId: productId,
      before: null,
      after: { name: item.name, category: categories.get(item.categoryId)!.name, description, images: 0, variants: [sku] },
    });
  }
  return { ok: true, variantIds };
}

/** Tên danh mục theo id (chỉ của công ty mình). */
export async function categoryNames(ids: readonly string[]): Promise<Map<string, string>> {
  const all = categoryNamesOf(await findCategories());
  return new Map(ids.flatMap((id) => (all.has(id) ? [[id, all.get(id)!] as const] : [])));
}

const categoryNamesOf = (rows: { id: string; name: string }[]) => new Map(rows.map((c) => [c.id, c.name]));
