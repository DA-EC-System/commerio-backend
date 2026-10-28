import { randomUUID } from 'node:crypto';
import { categories, products, productVariants } from '#src/modules/product/catalog/repository/schema.ts';
import { withCompany } from '#src/shared/db/client.ts';

/**
 * Một biến thể (kèm danh mục, sản phẩm mới) của công ty, ghi qua bảng của catalog trong `withCompany`
 * như request thật (RLS, role commerio_app). API sản phẩm là #12; khi có thì vẫn giữ helper này cho test module khác.
 */
export async function createVariant(companyId: string, options: { sku?: string; categoryName?: string } = {}) {
  const suffix = randomUUID().slice(0, 8);
  return withCompany(companyId, async (tx) => {
    const [category] = await tx
      .insert(categories)
      .values({ companyId, name: options.categoryName ?? `Danh mục ${suffix}`, skuPattern: 'TEST-{SEQ}' })
      .returning({ id: categories.id });
    const [product] = await tx
      .insert(products)
      .values({ companyId, categoryId: category!.id, name: `Sản phẩm ${suffix}` })
      .returning({ id: products.id });
    const sku = options.sku ?? `TEST-${suffix.toUpperCase()}`;
    const [variant] = await tx
      .insert(productVariants)
      .values({ companyId, productId: product!.id, sku })
      .returning({ id: productVariants.id });
    return { variantId: variant!.id, productId: product!.id, categoryId: category!.id, sku };
  });
}
