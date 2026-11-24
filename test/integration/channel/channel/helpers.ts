import {
  type MarketplaceAdapter,
  MarketplaceError,
  type SellerInfo,
  type DeclaredCapabilities,
} from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { testPool } from '../../helpers/db.ts';

const unsupported = async (): Promise<never> => {
  throw new MarketplaceError('unsupported');
};

/** Năng lực mặc định của adapter giả: như Lazada (Documents/21 §18.6.3). */
export const FAKE_CAPABILITIES: DeclaredCapabilities = {
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

/**
 * Cấu hình phí đang áp dụng của gian hàng, ghi thẳng bảng (role chủ bảng), không qua luồng duyệt. Từ 21 §18.9 R5 gian hàng
 * chưa có phí không đăng được (`fee_not_configured`); mặc định phí 0 để giá đăng như trước (giá chuẩn khi chưa có giá muốn bán).
 */
export async function seedFeeConfig(companyId: string, shopId: string, payload: object = { fixedPct: 0, transactionPct: 0, servicePct: 0, optionalPct: 0, returnFee: 0 }) {
  await testPool().query(
    `insert into finance.config_versions (company_id, kind, shop_id, status, payload, effective_from, created_by, approved_by, approved_at)
     values ($1, 'fee', $2, 'active', $3, '2026-01-01', gen_random_uuid(), gen_random_uuid(), now())`,
    [companyId, shopId, JSON.stringify(payload)],
  );
}

/**
 * Spec sàn của sản phẩm (#400 lát 15): dữ liệu đẩy dựng thẳng bằng spec thay cho ghép danh mục cũ (bỏ ở BE3).
 * Mỗi sản phẩm một dòng `version = 1`, trục của biến thể ánh xạ `__custom`; sản phẩm đã có spec của sàn thì giữ.
 */
export async function seedSpecs(
  companyId: string,
  platform: string,
  externalCategoryId: string,
  variants: readonly { productId: string; attributes?: readonly { attributeId: string }[] }[],
  attributes: Record<string, string | string[]> = {},
): Promise<void> {
  const byProduct = new Map<string, Record<string, string>>();
  for (const v of variants) {
    const axes = byProduct.get(v.productId) ?? {};
    for (const a of v.attributes ?? []) axes[a.attributeId] = '__custom';
    byProduct.set(v.productId, axes);
  }
  for (const [productId, axisMap] of byProduct) {
    await testPool().query(
      `insert into channel.product_specs (company_id, product_id, platform, external_category_id, attributes, axis_map, source, version)
       values ($1, $2, $3, $4, $5, $6, 'push', 1) on conflict (product_id, platform) do nothing`,
      [companyId, productId, platform, externalCategoryId, JSON.stringify(attributes), JSON.stringify(axisMap)],
    );
  }
}
