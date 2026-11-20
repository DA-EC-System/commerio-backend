// Xoá sản phẩm Lazada cho gom lại dữ liệu cũ (#295, Documents/21 §18.8.4). `/product/remove` với `sku_id_list` =
// JSON mảng `SkuId_<item>_<sku>` (đo 21/11/2026, Documents/tich-hop-san/goi-thu-bien-the-thong-so.md ca L3, và `removeVariants`
// ở `lazada.ts`); xoá mọi SKU của item thì mất cả item. SkuId đọc từ `/product/item/get`.
import type { MarketplaceAdapter } from './common.ts';
import { lazadaSkuViews } from './lazada-category-change.ts';

type Row = Record<string, unknown>;
type LazadaCall = (path: string, params: Record<string, string>, method: 'GET' | 'POST' | 'FORM') => Promise<Row>;

export function lazadaDeleteMethods(call: LazadaCall): Pick<MarketplaceAdapter, 'deleteProducts'> {
  return {
    async deleteProducts(accessToken, externalProductIds) {
      for (const itemId of externalProductIds) {
        const skuIds = lazadaSkuViews((await call('/product/item/get', { access_token: accessToken, item_id: itemId }, 'GET')).data)
          .map((s) => s.skuId)
          .filter(Boolean);
        // Item không còn SKU nào: đã xoá, gọi lại an toàn.
        if (!skuIds.length) continue;
        const sku_id_list = JSON.stringify(skuIds.map((id) => `SkuId_${itemId}_${id}`));
        await call('/product/remove', { access_token: accessToken, sku_id_list }, 'FORM');
      }
    },
  };
}
