// Readiness đăng của một sản phẩm theo từng gian hàng (be#564, Documents/21 §18.10). Không ghi, không gọi sàn. Mục chặn lấy từ
// `checkVariant`, cùng hàm với `push` và `push-preview`, nên ba nơi không lệch nhau.
import { AppError } from '../../../../shared/errors/app-error.ts';
import { type Blocker, displayBlockers } from '../domain/blocker.ts';
import { pickSources } from '../domain/category-sources.ts';
import type { Marketplace } from '../repository/schema.ts';
import { categoryInfoOf } from '../repository/platform-categories.ts';
import { specUsesOf } from '../repository/product-specs.ts';
import { listShopRows } from '../repository/shops.ts';
import type { ProductPort } from './product-port.ts';
import { maxAxesOf } from './platform-categories.ts';
import { checkVariant, LISTED, loadPushContext } from './push-check.ts';
import { platformOf } from './shops.ts';

export interface CategoryState {
  state: 'chosen' | 'suggested' | 'none';
  externalCategoryId: string | null;
  path: string | null;
  source: 'push' | 'match' | 'group' | 'recent' | null;
  maxAxes: number | null;
  /** Leaf có đích ghép thuộc tính biến thể (18.8.3, be#568); `null` tới khi có `combineTarget` hoặc khi chưa lấy attribute. */
  combinable: boolean | null;
}

export interface ShopReadiness {
  shopId: string;
  shopName: string;
  platform: Marketplace;
  status: 'ready' | 'blocked';
  counts: { ready: number; blocked: number; listed: number };
  category: CategoryState;
  blockers: Blocker[];
  variants: { variantId: string; status: 'ready' | 'blocked' | 'listed'; blockerCodes: string[] }[];
}

/** Listing đang ở trên sàn hoặc đang đẩy: không cần đăng, không tính vào đăng được hay bị chặn. */
const LISTED_OR_PUSHING = new Set<string>([...LISTED, 'pushing']);

/** Gọi trong `withCompany`. `shopId` chỉ lấy một gian hàng. */
export async function productReadiness(port: ProductPort, productId: string, shopId?: string): Promise<{ items: ShopReadiness[] }> {
  const catalog = await port.variants(undefined, { productIds: [productId] });
  if (!catalog.length) throw new AppError(404, 'not_found', 'Không tìm thấy sản phẩm');
  const live = catalog.filter((v) => !v.archived);
  const ids = live.map((v) => v.id);
  const shops = (await listShopRows()).filter((s) => s.status !== 'disconnected' && (!shopId || s.id === shopId));
  if (shopId && !shops.length) throw new AppError(404, 'not_found', 'Không tìm thấy gian hàng');

  const items: ShopReadiness[] = [];
  // Sản phẩm cùng nhóm hàng cho gợi ý `group`: đọc một lần, chỉ khi cần (gian hàng nào đó chưa có spec).
  let sameGroup: Set<string> | undefined;
  const sameGroupOf = async () => {
    const groupId = live[0]?.groupId;
    sameGroup ??= groupId ? new Set((await port.variants()).filter((v) => v.groupId === groupId).map((v) => v.productId)) : new Set();
    return sameGroup;
  };
  // Cùng một kết nối của giao dịch: đọc tuần tự từng gian hàng.
  for (const shop of shops) {
    const ctx = await loadPushContext(port, shop, ids);
    const rows: { variantId: string; items: ReturnType<typeof checkVariant>['items'] }[] = [];
    const variants: ShopReadiness['variants'] = [];
    for (const id of ids) {
      const existing = ctx.current.get(id);
      if (existing && LISTED_OR_PUSHING.has(existing.status)) {
        variants.push({ variantId: id, status: 'listed', blockerCodes: [] });
        continue;
      }
      const { items: found } = checkVariant(ctx, id);
      rows.push({ variantId: id, items: found });
      variants.push({ variantId: id, status: found.length ? 'blocked' : 'ready', blockerCodes: found.map((b) => b.code) });
    }
    const category = await categoryState(shop.platform, productId, sameGroupOf, ctx.specs.get(productId));
    const blockers = displayBlockers(rows).map((b) => (b.code === 'axis_limit' ? { ...b, label: axisLimitLabel(category, live) ?? b.label } : b));
    const counts = {
      ready: variants.filter((v) => v.status === 'ready').length,
      blocked: variants.filter((v) => v.status === 'blocked').length,
      listed: variants.filter((v) => v.status === 'listed').length,
    };
    items.push({
      shopId: shop.id,
      shopName: shop.shopName,
      platform: shop.platform,
      status: counts.ready > 0 ? 'ready' : 'blocked',
      counts,
      category,
      blockers,
      variants,
    });
  }
  return { items };
}

/** "Category {path} chỉ nhận {maxAxes} thuộc tính biến thể, sản phẩm có {n}" (21 §18.10). */
function axisLimitLabel(category: CategoryState, variants: readonly { attributes: readonly { attributeId: string }[] }[]): string | null {
  if (category.maxAxes === null) return null;
  const axes = new Set(variants.flatMap((v) => v.attributes.map((a) => a.attributeId))).size;
  return `Category ${category.path ?? category.externalCategoryId} chỉ nhận ${category.maxAxes} thuộc tính biến thể, sản phẩm có ${axes}`;
}

async function categoryState(
  platform: Marketplace,
  productId: string,
  sameGroupOf: () => Promise<ReadonlySet<string>>,
  spec: Awaited<ReturnType<typeof loadPushContext>>['specs'] extends ReadonlyMap<string, infer S> ? S | undefined : never,
): Promise<CategoryState> {
  const { adapter } = platformOf(platform);
  if (spec) {
    const info = (await categoryInfoOf(platform, [spec.externalCategoryId])).get(spec.externalCategoryId);
    const caps = spec.attributes ? (adapter.variantCapabilities?.(spec.attributes) ?? null) : null;
    return {
      state: 'chosen',
      externalCategoryId: spec.externalCategoryId,
      path: info?.path ?? null,
      source: spec.row.source,
      maxAxes: caps?.maxAxes ?? null,
      combinable: null,
    };
  }
  // Gợi ý không gọi sàn: `group` rồi `recent`, như hai nguồn cùng tên của `category-suggestions`.
  const specs = await specUsesOf(platform);
  const sameGroup = await sameGroupOf();
  const infos = await categoryInfoOf(platform, specs.map((s) => s.externalCategoryId));
  const removedIds = new Set([...infos].filter(([, i]) => i.status === 'removed').map(([id]) => id));
  const { group, recent } = pickSources({ specs, productId, sameGroupProductIds: sameGroup, itemIds: new Set(), removedIds });
  const pick = group[0] ? { use: group[0], source: 'group' as const } : recent[0] ? { use: recent[0], source: 'recent' as const } : null;
  if (!pick) return { state: 'none', externalCategoryId: null, path: null, source: null, maxAxes: null, combinable: null };
  return {
    state: 'suggested',
    externalCategoryId: pick.use.externalId,
    path: infos.get(pick.use.externalId)?.path ?? null,
    source: pick.source,
    maxAxes: (await maxAxesOf(platform, [pick.use.externalId])).get(pick.use.externalId) ?? null,
    combinable: null,
  };
}
