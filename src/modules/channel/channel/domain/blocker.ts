// Mục chặn đẩy listing dùng chung cho readiness, push, push-preview và lỗi đẩy của sàn (be#564, #566, #567; Documents/21 §18.10).
// Đặt ở domain để hàm thuần (domain/push-error.ts) import được; service/push-block.ts dựng mục chặn và re-export.

/** Mã chặn (21 §18.5, §18.6.4, §18.10). */
export type BlockerCode =
  // Dữ liệu của biến thể, sản phẩm, spec (pushBlocks).
  | 'sku_not_ready'
  | 'price_missing'
  | 'category_unmapped'
  | 'spec_incomplete'
  | 'axis_limit'
  | 'axis_unmapped_required'
  | 'category_not_permitted'
  | 'dimensions_missing'
  | 'images_missing'
  | 'variant_images_missing'
  | 'size_chart_missing'
  // Theo gian hàng, kiểm ngoài pushBlocks.
  | 'fee_not_configured'
  | 'below_floor'
  | 'platform_product_ambiguous'
  // Gom biến thể vào một sản phẩm sàn (#566): kiểm khi spec không còn `missing`.
  | 'axis_shape'
  | 'axis_unmapped'
  // Trạng thái listing (chỉ push, push-preview; readiness tính các listing này là `listed`).
  | 'not_found'
  | 'push_in_progress'
  | 'mapping_pending'
  | 'already_listed';

/** Chỗ sửa của một mục chặn (21 §18.10 `BlockerTarget`). */
export type BlockerTarget =
  | { kind: 'category' }
  | { kind: 'spec_attribute'; attributeCode: string }
  | { kind: 'axis'; attributeId?: string }
  | { kind: 'variant_field'; field: 'price' | 'weight' | 'dimensions' }
  | { kind: 'product_field'; field: 'images' | 'variantImages' | 'sizeChart' | 'name' }
  | { kind: 'shop'; field: 'fee_config' | 'category_permission' }
  | { kind: 'platform_product'; externalProductIds: string[] }
  | { kind: 'listing'; listingId: string | null };

export type BlockerScope = 'common' | 'platform' | 'shop';

/** Một mục chặn của một biến thể ở một gian hàng; `label` là câu cho người bán. */
export interface BlockItem {
  code: BlockerCode;
  label: string;
  target: BlockerTarget;
}

/** Mục chặn đã gom theo mã và chỗ sửa trên nhiều biến thể (21 §18.10 `Blocker`). */
export interface Blocker extends BlockItem {
  scope: BlockerScope;
  variantIds: string[];
}

const COMMON_CODES: ReadonlySet<BlockerCode> = new Set(['sku_not_ready', 'price_missing', 'dimensions_missing', 'images_missing']);
const SHOP_CODES: ReadonlySet<BlockerCode> = new Set([
  'fee_not_configured',
  'below_floor',
  'category_not_permitted',
  'not_found',
  'push_in_progress',
  'mapping_pending',
  'already_listed',
]);

/**
 * `common`: không theo sàn, lặp ở mọi gian hàng; `shop`: riêng gian hàng; còn lại là thông tin sàn, chung mọi gian hàng cùng sàn
 * (21 §18.10).
 */
export const blockerScope = (code: BlockerCode): BlockerScope => (COMMON_CODES.has(code) ? 'common' : SHOP_CODES.has(code) ? 'shop' : 'platform');

/** Gom mục chặn của nhiều biến thể theo mã và chỗ sửa, giữ thứ tự gặp đầu tiên. */
export function groupBlockers(rows: readonly { variantId: string; items: readonly BlockItem[] }[]): Blocker[] {
  const byKey = new Map<string, Blocker>();
  for (const { variantId, items } of rows) {
    for (const item of items) {
      const key = `${item.code}|${JSON.stringify(item.target)}`;
      const found = byKey.get(key);
      if (found) {
        if (!found.variantIds.includes(variantId)) found.variantIds.push(variantId);
      } else {
        byKey.set(key, { ...item, scope: blockerScope(item.code), variantIds: [variantId] });
      }
    }
  }
  return [...byKey.values()];
}

/** Thứ tự hiển thị cố định: mục của sản phẩm theo sàn, rồi mục của SKU, rồi mục của gian hàng (21 §18.10). */
const SCOPE_ORDER: Record<BlockerScope, number> = { platform: 0, common: 1, shop: 2 };

/**
 * Gom rồi xếp theo thứ tự hiển thị (sắp ổn định: cùng scope giữ thứ tự gặp). `PushResult.code` vẫn lấy theo thứ tự ưu tiên của
 * push (`firstBlock`), không theo thứ tự này.
 */
export const displayBlockers = (rows: readonly { variantId: string; items: readonly BlockItem[] }[]): Blocker[] =>
  groupBlockers(rows).sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope]);
