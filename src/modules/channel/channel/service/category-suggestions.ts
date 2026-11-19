import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import type { ModuleContext } from '../../../../shared/module.ts';
import { type CategoryPermission, permissionOf } from '../domain/product-spec.ts';
import { findCategory } from '../repository/platform-categories.ts';
import { upsertPermissions } from '../repository/product-specs.ts';
import { type CategorySuggestion, type MarketplaceAdapter, MarketplaceError } from './marketplaces/index.ts';
import { productPort } from './product-port.ts';
import { onMarketplace, shopSession } from './shops.ts';

export interface SuggestionItem {
  externalId: string;
  path: string;
  permission: CategoryPermission | null;
}

/** Chưa có Redis (A2, chốt 18/11/2026): gọi sàn mỗi lần, `cached` luôn false. */
export interface SuggestionResult {
  items: SuggestionItem[];
  cached: boolean;
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
 * Gợi ý category của sàn cho một sản phẩm, theo tên và ảnh đầu, bằng token gian hàng (#400 lát 9, Documents/21 §18.5).
 * Thứ tự kiểm: 404 gian hàng → 409 `shop_not_connected` (không `active`) → 404 sản phẩm → 422 `product_name_too_short`
 * (sàn có `minNameLength`) → 422 `images_missing` (sàn `needsImage`); cả hai 422 không gọi sàn. Gọi sàn ngoài giao dịch.
 * Đường dẫn lấy từ cây đã đồng bộ khi có (A10: Lazada trả tiếng Anh). Quyền của gian hàng (TikTok) ghi vào
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
    const name = variants[0]!.productName.trim();
    const rules = session.adapter.suggestionRules ?? {};
    if (rules.minNameLength && [...name].length < rules.minNameLength) {
      throw new AppError(422, 'product_name_too_short', `Sàn cần tên sản phẩm từ ${rules.minNameLength} ký tự để gợi ý category`, {
        min: rules.minNameLength,
      });
    }
    const imageUrl = (await port.productImageUrls([productId], 1)).get(productId)?.[0] ?? null;
    if (rules.needsImage && !imageUrl) {
      throw new AppError(422, 'images_missing', 'Sàn cần ảnh sản phẩm để gợi ý category: thêm ảnh cho sản phẩm');
    }
    return { session, name, imageUrl };
  });

  const { shop, adapter, accessToken } = prep.session;
  const suggest = (adapter as MarketplaceAdapter).suggestCategories;
  if (!suggest) throw new AppError(422, 'marketplace_unsupported', 'Sàn chưa hỗ trợ gợi ý category');
  const raw: CategorySuggestion[] = await onMarketplace(() =>
    callWithRetry(() => suggest.call(adapter, accessToken, { name: prep.name, imageUrl: prep.imageUrl })),
  );

  const items: SuggestionItem[] = [];
  for (const s of raw) {
    const category = await findCategory(shop.platform, s.externalId);
    items.push({
      externalId: s.externalId,
      path: category?.syncedAt ? category.path : s.path,
      permission: s.permissionStatuses ? permissionOf(s.permissionStatuses) : null,
    });
  }
  const permissions = items.flatMap((i) => (i.permission ? [{ externalCategoryId: i.externalId, status: i.permission }] : []));
  if (permissions.length) {
    await withCompany(companyId, () => upsertPermissions(companyId, shop.id, permissions, new Date()));
  }
  return { items, cached: false };
}
