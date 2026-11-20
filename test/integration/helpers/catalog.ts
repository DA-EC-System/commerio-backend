import { randomUUID } from 'node:crypto';
import { productGroups, products, productVariants } from '#src/modules/product/catalog/repository/schema.ts';
import { withCompany } from '#src/shared/db/client.ts';

/**
 * Một biến thể (kèm nhóm hàng, sản phẩm mới) của công ty, ghi qua bảng của catalog trong `withCompany`
 * như request thật (RLS, role commerio_app). API sản phẩm là #12; khi có thì vẫn giữ helper này cho test module khác.
 */
export async function createVariant(companyId: string, options: { sku?: string; groupName?: string } = {}) {
  const suffix = randomUUID().slice(0, 8);
  return withCompany(companyId, async (tx) => {
    const [group] = await tx
      .insert(productGroups)
      .values({ companyId, name: options.groupName ?? `Nhóm ${suffix}` })
      .returning({ id: productGroups.id });
    const [product] = await tx
      .insert(products)
      .values({ companyId, groupId: group!.id, name: `Sản phẩm ${suffix}`, code: `SP-${suffix.toUpperCase()}` })
      .returning({ id: products.id });
    const sku = options.sku ?? `TEST-${suffix.toUpperCase()}`;
    const [variant] = await tx
      .insert(productVariants)
      .values({ companyId, productId: product!.id, sku })
      .returning({ id: productVariants.id });
    return { variantId: variant!.id, productId: product!.id, groupId: group!.id, sku };
  });
}
