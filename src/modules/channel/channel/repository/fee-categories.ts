// Category sàn của SKU ở một gian hàng, để chọn hoa hồng theo category của cấu hình phí (Documents/21 §21.4).
import { and, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { listings, productSpecs, shops } from './schema.ts';

/**
 * Category của từng SKU ở gian hàng: `listings.external_category_id` của listing chưa gỡ, không có thì category của thông
 * tin sàn của sản phẩm (`product_specs`, cùng sàn). SKU không có cả hai thì vắng. `productOf` là sản phẩm cha của SKU
 * (đọc qua cổng product). Gọi trong `withCompany`.
 */
export async function variantCategoryIds(
  shopId: string,
  productOf: ReadonlyMap<string, string>,
): Promise<{ platform: string | null; categories: Map<string, string> }> {
  const variantIds = [...productOf.keys()];
  const [shop] = await getDb().select({ platform: shops.platform }).from(shops).where(eq(shops.id, shopId));
  if (!shop || !variantIds.length) return { platform: shop?.platform ?? null, categories: new Map() };
  const listed = await getDb()
    .select({ variantId: listings.variantId, categoryId: listings.externalCategoryId })
    .from(listings)
    .where(
      and(eq(listings.shopId, shopId), inArray(listings.variantId, variantIds), ne(listings.status, 'delisted'), isNotNull(listings.externalCategoryId)),
    );
  const categories = new Map(listed.map((r) => [r.variantId!, r.categoryId!]));
  const productIds = [...new Set(variantIds.filter((id) => !categories.has(id)).map((id) => productOf.get(id)!))];
  if (productIds.length) {
    const specs = await getDb()
      .select({ productId: productSpecs.productId, categoryId: productSpecs.externalCategoryId })
      .from(productSpecs)
      .where(and(eq(productSpecs.platform, shop.platform), inArray(productSpecs.productId, productIds)));
    const byProduct = new Map(specs.map((s) => [s.productId, s.categoryId]));
    for (const id of variantIds) {
      const c = categories.has(id) ? undefined : byProduct.get(productOf.get(id)!);
      if (c) categories.set(id, c);
    }
  }
  return { platform: shop.platform, categories };
}
