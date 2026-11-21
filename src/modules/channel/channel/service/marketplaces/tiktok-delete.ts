// Xoá sản phẩm TikTok Shop cho gom lại dữ liệu cũ (#295, Documents/21 §18.8.4).
// Nguồn: Documents/tich-hop-san/tiktok.md mục 11 (gọi thật 09/11/2026): `POST /product/202309/products/deactivate`
// `{ product_ids }` rồi `DELETE /product/202309/products` cùng body → `code` 0, Get Product trả `status: DELETED`; docv2
// delete-products-202309. Mỗi sản phẩm lỗi nằm ở `data.errors[]` dù `code` 0.
import { MarketplaceError, type MarketplaceAdapter } from './common.ts';
import type { TiktokClient } from './tiktok-client.ts';

type Row = Record<string, unknown>;
type Errors = { errors?: Row[] };

const errorOf = (e: Row) => ({
  code: String(e.code ?? 'unexpected_response'),
  message: typeof e.message === 'string' ? e.message : typeof e.detail === 'string' ? e.detail : undefined,
});

export function tiktokDeleteMethods(client: TiktokClient): Pick<MarketplaceAdapter, 'deleteProducts'> {
  return {
    async deleteProducts(token, externalProductIds) {
      if (!externalProductIds.length) return;
      const body = { product_ids: [...externalProductIds] };
      // Tắt trước: sản phẩm đang bán không xoá được. Sản phẩm đã tắt hay đã xoá báo lỗi từng sản phẩm, bỏ qua vì bước xoá
      // dưới đây quyết kết quả.
      await client.call<Errors>('POST', '/product/202309/products/deactivate', { token, body });
      const data = await client.call<Errors>('DELETE', '/product/202309/products', { token, body });
      const first = (data?.errors ?? [])[0];
      if (first) {
        const { code, message } = errorOf(first);
        throw new MarketplaceError('rejected', code, message);
      }
    },
  };
}
