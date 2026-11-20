import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import type { ModuleContext } from '../../../../shared/module.ts';
import { pickSources } from '../domain/category-sources.ts';
import { type CategoryPermission, permissionOf } from '../domain/product-spec.ts';
import { categoryInfoOf } from '../repository/platform-categories.ts';
import { permissionsOf, specUsesOf, upsertPermissions } from '../repository/product-specs.ts';
import { type CategorySuggestion, type MarketplaceAdapter, MarketplaceError } from './marketplaces/index.ts';
import { productPort } from './product-port.ts';
import { onMarketplace, shopSession } from './shops.ts';

export interface SuggestionItem {
  externalId: string;
  path: string;
  permission: CategoryPermission | null;
  /** Công ty đã dùng category này trong spec của sản phẩm nào đó trên sàn. */
  usedByCompany: boolean;
}

/** Category lấy từ spec của công ty (`group`, `recent`). */
export interface UsedCategory {
  externalId: string;
  path: string;
  productCount: number;
  permission: CategoryPermission | null;
}

export interface SuggestError {
  code: 'product_name_too_short' | 'images_missing' | 'marketplace_unavailable';
  message: string;
  min?: number;
}

/** Chưa có Redis (A2, chốt 18/11/2026): gọi sàn mỗi lần, `cached` luôn false. */
export interface SuggestionResult {
  items: SuggestionItem[];
  /** Category của sản phẩm cùng nhóm hàng đã dùng trên sàn này (#448, Documents/21 §18.8.5). */
  group: UsedCategory[];
  /** Category công ty dùng gần đây, bỏ phần đã ở `items`, `group`. */
  recent: UsedCategory[];
  cached: boolean;
  /** Không gọi được sàn: `items` rỗng kèm lý do, `group`, `recent` vẫn trả. */
  suggestError?: SuggestError;
}

/** Gọi sàn một lần, sàn báo `unavailable` (lỗi tạm) thì gọi lại một lần (Documents/21 §18.5). */
async function callWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MarketplaceError && err.kind === 'unavailable') return fn();
    throw err;
  }
}

/**
 * Gợi ý category của sàn cho một sản phẩm, theo tên, mô tả và ảnh đầu, bằng token gian hàng, cộng hai nguồn đọc từ DB: category
 * của sản phẩm cùng nhóm hàng (`group`) và công ty dùng gần đây (`recent`) (#400 lát 9, #448, Documents/21 §18.5, §18.8.5).
 * Thứ tự kiểm: 404 gian hàng → 409 `shop_not_connected` (không `active`) → 404 sản phẩm → 422 `marketplace_unsupported`. Không gọi
 * được sàn thì 200 `items: []` kèm `suggestError`: tên ngắn hơn `minNameLength` (`product_name_too_short`), sàn cần ảnh mà
 * sản phẩm chưa có (`images_missing`), sàn lỗi sau một lần gọi lại (`marketplace_unavailable`); hai lỗi đầu không gọi sàn. Gọi sàn
 * ngoài giao dịch. Đường dẫn lấy từ cây đã đồng bộ khi có (A10: Lazada trả tiếng Anh). Quyền của gian hàng (TikTok) ghi vào
 * `shop_category_permissions` trong `withCompany`.
 */
export async function suggestCategories(ctx: ModuleContext, companyId: string, shopId: string, productId: string): Promise<SuggestionResult> {
  const prep = await withCompany(companyId, async () => {
    const session = await shopSession(shopId);
    if (session.shop.status !== 'active') {
      throw new AppError(409, 'shop_not_connected', 'Gian hàng chưa kết nối xong hoặc cần kết nối lại', { current: session.shop.status });
    }
    const port = productPort(ctx);
    const variants = await port.variants(undefined, { productIds: [productId] });
    if (!variants.length) throw new AppError(404, 'not_found', 'Không tìm thấy sản phẩm');
    const first = variants[0]!;
    const name = first.productName.trim();
    const rules = session.adapter.suggestionRules ?? {};
    let suggestError: SuggestError | undefined;
    if (rules.minNameLength && [...name].length < rules.minNameLength) {
      suggestError = {
        code: 'product_name_too_short',
        message: `Sàn cần tên sản phẩm từ ${rules.minNameLength} ký tự để gợi ý category`,
        min: rules.minNameLength,
      };
    }
    const imageUrl = (await port.productImageUrls([productId], 1)).get(productId)?.[0] ?? null;
    if (!suggestError && rules.needsImage && !imageUrl) {
      suggestError = { code: 'images_missing', message: 'Sàn cần ảnh sản phẩm để gợi ý category: thêm ảnh cho sản phẩm' };
    }
    // Nhóm hàng của mọi sản phẩm công ty để tìm sản phẩm cùng nhóm (chỉ cần khi có spec của sản phẩm khác).
    const groupOf = new Map<string, string>();
    for (const v of await port.variants()) groupOf.set(v.productId, v.groupId);
    return { session, name, description: first.description, imageUrl, suggestError, groupId: first.groupId, groupOf };
  });

  const { shop, adapter, accessToken } = prep.session;
  const suggest = (adapter as MarketplaceAdapter).suggestCategories;
  if (!suggest) throw new AppError(422, 'marketplace_unsupported', 'Sàn chưa hỗ trợ gợi ý category');

  let suggestError = prep.suggestError;
  let raw: CategorySuggestion[] = [];
  if (!suggestError) {
    try {
      raw = await onMarketplace(() =>
        callWithRetry(() => suggest.call(adapter, accessToken, { name: prep.name, description: prep.description, imageUrl: prep.imageUrl })),
      );
    } catch (err) {
      if (!(err instanceof AppError) || err.code !== 'marketplace_unavailable') throw err;
      suggestError = { code: 'marketplace_unavailable', message: 'Sàn đang lỗi, chưa gợi ý được category. Thử lại sau hoặc chọn từ danh sách bên dưới' };
    }
  }

  return withCompany(companyId, async () => {
    const infos = await categoryInfoOf(shop.platform, raw.map((s) => s.externalId));
    const permissions = raw.flatMap((s) => {
      const status = s.permissionStatuses ? permissionOf(s.permissionStatuses) : null;
      return status ? [{ externalCategoryId: s.externalId, status }] : [];
    });
    if (permissions.length) await upsertPermissions(companyId, shop.id, permissions, new Date());

    const specs = await specUsesOf(shop.platform);
    const used = new Set(specs.map((s) => s.externalCategoryId));
    const itemIds = new Set(raw.map((s) => s.externalId));
    const sameGroup = new Set([...prep.groupOf].filter(([, g]) => g === prep.groupId).map(([p]) => p));
    // Trạng thái category của mọi category công ty đã dùng, để bỏ `removed` trước khi cắt 5.
    const usedInfos = await categoryInfoOf(shop.platform, [...used]);
    const removedIds = new Set([...usedInfos].filter(([, i]) => i.status === 'removed').map(([id]) => id));
    const { group, recent } = pickSources({ specs, productId, sameGroupProductIds: sameGroup, itemIds, removedIds });

    const shown = [...group, ...recent].map((u) => u.externalId);
    const known = await permissionsOf(shop.id, [...itemIds, ...shown]);
    const permissionOfId = (id: string) => known.get(id)?.status ?? null;
    const items: SuggestionItem[] = raw.map((s) => ({
      externalId: s.externalId,
      path: infos.get(s.externalId)?.path ?? s.path,
      permission: s.permissionStatuses ? permissionOf(s.permissionStatuses) : null,
      usedByCompany: used.has(s.externalId),
    }));
    const usedView = (u: { externalId: string; productCount: number }): UsedCategory => ({
      externalId: u.externalId,
      path: usedInfos.get(u.externalId)?.path ?? u.externalId,
      productCount: u.productCount,
      permission: permissionOfId(u.externalId),
    });
    return { items, group: group.map(usedView), recent: recent.map(usedView), cached: false, ...(suggestError && { suggestError }) };
  });
}
