// Sản phẩm mới từ đề nghị nhập (#108, Documents/25 §3.2): purchasing kiểm khi lập, tạo khi CEO duyệt.
// Chạy trong `withCompany` của bên gọi, không tự mở giao dịch (withCompany không lồng được).
import { recordAudit } from '../../../core/index.ts';
import { findGroups } from '../repository/groups.ts';
import { insertProduct, productNameExists } from '../repository/products.ts';
import { insertVariant, lockVariants } from '../repository/variants.ts';
import { allocateSkus, productCodeFor, SKU_TOO_LONG } from './sku-allocation.ts';

export interface NewProductItem {
  name: string;
  groupId: string;
}

/** Lỗi theo chỉ số mục: trường nào sai và câu báo (`null` là lỗi của cả dòng, vd SKU quá dài). Rỗng là hợp lệ. */
export type NewProductErrors = Map<number, { field: 'name' | 'groupId' | null; message: string }>;

/** Nhóm hàng có thật trong công ty, tên chưa có sản phẩm nào dùng (chữ thường), các mục không trùng tên nhau. */
export async function validateNewProducts(items: readonly NewProductItem[]): Promise<NewProductErrors> {
  const errors: NewProductErrors = new Map();
  const names = groupNamesOf(await findGroups());
  const seen = new Set<string>();
  for (const [i, item] of items.entries()) {
    const key = item.name.toLowerCase();
    if (!names.has(item.groupId)) errors.set(i, { field: 'groupId', message: 'Chọn nhóm hàng' });
    else if (seen.has(key)) errors.set(i, { field: 'name', message: 'Sản phẩm mới bị lặp' });
    else if (await productNameExists(item.name)) errors.set(i, { field: 'name', message: 'Đã có sản phẩm cùng tên' });
    seen.add(key);
  }
  return errors;
}

/**
 * Mỗi mục một sản phẩm với một biến thể không thuộc tính, SKU theo mẫu của công ty. Trả `variantId` đúng thứ tự
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
  const groups = groupNamesOf(await findGroups());
  const variantIds: string[] = [];
  for (const [i, item] of items.entries()) {
    // Cấp SKU từng mục: `allocateSkus` đọc lại `sku_next_seq` vừa tăng của công ty.
    const allocation = await allocateSkus(caller.companyId, [[]]);
    if (!allocation.ok) return { ok: false, errors: new Map([[i, { field: null, message: SKU_TOO_LONG }]]) };
    const { sku, seq } = allocation.skus[0]!;
    const code = await productCodeFor(allocation.pattern, seq);
    const productId = await insertProduct(caller.companyId, item.groupId, item.name, description, code);
    const variantId = await insertVariant(caller.companyId, productId, sku, [], 0);
    variantIds.push(variantId);
    await recordAudit({
      companyId: caller.companyId,
      actorId: caller.accountId,
      action: 'create',
      entityType: 'product.products',
      entityId: productId,
      label: item.name,
      before: null,
      after: {
        name: item.name,
        code,
        group: groups.get(item.groupId)!,
        description,
        imageFileIds: [],
        variants: [sku],
      },
    });
  }
  return { ok: true, variantIds };
}

/** Tên nhóm hàng theo id (chỉ của công ty mình). */
export async function groupNames(ids: readonly string[]): Promise<Map<string, string>> {
  const all = groupNamesOf(await findGroups());
  return new Map(ids.flatMap((id) => (all.has(id) ? [[id, all.get(id)!] as const] : [])));
}

const groupNamesOf = (rows: { id: string; name: string }[]) => new Map(rows.map((c) => [c.id, c.name]));
