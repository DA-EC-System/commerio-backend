import {
  type MarketplaceAdapter,
  MarketplaceError,
  type SellerInfo,
  type ShopCapabilities,
} from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { testPool } from '../../helpers/db.ts';

const unsupported = async (): Promise<never> => {
  throw new MarketplaceError('unsupported');
};

/** Năng lực mặc định của adapter giả: như Lazada (Documents/21 §18.6.3). */
export const FAKE_CAPABILITIES: ShopCapabilities = {
  listingReview: true,
  hideBy: 'deactivate',
  splitLevel: 'unit',
  returnWindow: 'days',
};

/**
 * Adapter giả: năng lực không truyền vào thì báo `unsupported`, để test chỉ khai phần mình dùng.
 * Truyền `getSeller` (một token là một seller) thì `connectWithToken` tự dựng như Lazada: có refresh token thì làm mới
 * một lần bằng `refreshToken`, không có thì hạn để trống.
 */
export function fakeAdapter(
  overrides: Partial<MarketplaceAdapter> & { getSeller?: (accessToken: string) => Promise<SellerInfo> },
): MarketplaceAdapter {
  const { getSeller, ...rest } = overrides;
  const adapter: MarketplaceAdapter = {
    name: 'Sàn giả',
    capabilities: FAKE_CAPABILITIES,
    connectMethods: () => [],
    authorizeUrl: () => {
      throw new MarketplaceError('unsupported');
    },
    exchangeCode: unsupported,
    connectWithToken: getSeller
      ? async ({ accessToken, refreshToken }) => {
          const tokens = refreshToken
            ? await adapter.refreshToken(refreshToken)
            : { accessToken, refreshToken: null, accessExpiresAt: null, refreshExpiresAt: null };
          return [{ ...(await getSeller(tokens.accessToken)), tokens }];
        }
      : unsupported,
    refreshToken: unsupported,
    listCategories: unsupported,
    categoryAttributes: unsupported,
    uploadImage: unsupported,
    createProduct: unsupported,
    getSkus: unsupported,
    updatePriceQuantity: unsupported,
    deactivate: unsupported,
    ...rest,
  };
  return adapter;
}

/**
 * Đưa gian hàng vừa nối (`connecting`) sang `active` như đã thiết lập trước #198 (có mốc, lượt đơn mở coi như xong, không
 * giữ tồn), không qua `POST /setup`. Đẩy listing chỉ khi gian hàng `active` (Documents/21 §18.6.4, 409 `shop_not_active`).
 */
export async function activateShop(shopId: string): Promise<void> {
  await testPool().query(
    "update channel.shops set status = 'active', order_cutoff_at = now(), open_orders_pulled_at = now() where id = $1",
    [shopId],
  );
}
