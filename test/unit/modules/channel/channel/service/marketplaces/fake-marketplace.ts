// Adapter giả tham chiếu (#200): cài `MarketplaceAdapter` trên một sàn trong bộ nhớ, để bộ ca hợp đồng có một bản
// chuẩn chạy được độc lập với Lazada, và để làm mẫu khi viết adapter sàn mới (#217). Không dùng cho test nghiệp vụ.
import {
  type MarketplaceAdapter,
  MarketplaceError,
  type ShopConnection,
} from '#src/modules/channel/channel/service/marketplaces/common.ts';

export interface FakeMarketplace {
  /** Cấu hình đủ chưa (thiếu thì không nối được, không gọi "mạng"). */
  configured: boolean;
  /** Mỗi lần "gọi mạng" tăng một; `fail` giả lỗi của lần gọi. */
  calls: number;
  fail: 'network' | 'http_5xx' | null;
  /** Token hợp lệ → các gian hàng của nó (một token có thể ra nhiều gian hàng, như TikTok). */
  tokens: Map<string, { externalShopId: string; shopName: string }[]>;
  /** Mã đơn → `updatedAt` ms. */
  orders: Map<string, number>;
}

const PAGE = 40;

export function createFakeMarketplace(sàn: FakeMarketplace): MarketplaceAdapter {
  const hit = () => {
    if (!sàn.configured) throw new MarketplaceError('unsupported');
    sàn.calls += 1;
    if (sàn.fail === 'network') throw new MarketplaceError('unavailable', null, 'mất mạng');
    if (sàn.fail === 'http_5xx') throw new MarketplaceError('unavailable', 'http_502');
  };
  const shopsOf = (accessToken: string): ShopConnection[] => {
    hit();
    const shops = sàn.tokens.get(accessToken);
    if (!shops) throw new MarketplaceError('unauthorized', 'invalid_token');
    return shops.map((s) => ({
      ...s,
      region: 'VN',
      // Bí mật theo gian hàng gói vào token (token chuỗi mờ, #200 A1).
      tokens: { accessToken: `${accessToken}|${s.externalShopId}`, refreshToken: null, accessExpiresAt: null, refreshExpiresAt: null },
    }));
  };
  const session = (accessToken: string) => {
    hit();
    const [token] = accessToken.split('|');
    if (!sàn.tokens.has(token!)) throw new MarketplaceError('unauthorized', 'invalid_token');
  };

  return {
    name: 'Sàn giả tham chiếu',
    capabilities: { listingReview: false, hideBy: 'zero_stock', splitLevel: 'none', returnWindow: 'platform_status' },
    connectMethods: () => (sàn.configured ? ['oauth', 'token'] : []),
    authorizeUrl(state) {
      if (!sàn.configured) throw new MarketplaceError('unsupported');
      return `https://fake.test/authorize?${new URLSearchParams({ state })}`;
    },
    async exchangeCode(params) {
      if (!params.code) throw new MarketplaceError('rejected', 'missing_parameter');
      return shopsOf(params.code.replace(/^code-/, ''));
    },
    async connectWithToken({ accessToken }) {
      return shopsOf(accessToken);
    },
    async refreshToken() {
      throw new MarketplaceError('unsupported');
    },
    async listCategories(accessToken) {
      session(accessToken);
      return [];
    },
    async categoryAttributes(accessToken) {
      session(accessToken);
      return [];
    },
    async uploadImage(accessToken, url) {
      session(accessToken);
      return url;
    },
    async createProduct() {
      throw new MarketplaceError('unsupported');
    },
    async getSkus(accessToken, sellerSkus) {
      session(accessToken);
      return sellerSkus.map((sku, i) => ({
        externalProductId: `p-${sku}`,
        externalSkuId: `s-${sku}`,
        sellerSku: sku,
        title: sku,
        state: i % 2 ? 'review' : 'live',
        rejectReason: null,
        quantity: 0,
      }));
    },
    async updatePriceQuantity(accessToken, items) {
      session(accessToken);
      return items.map((i) => ({ externalSkuId: i.externalSkuId, ok: true as const }));
    },
    async deactivate(accessToken) {
      session(accessToken);
    },
    // Lật trang theo khoá (updatedAt, mã đơn) đã trả cuối cùng: đơn đổi nhảy ra sau khoá nên vẫn được trả, không sót.
    async listOrders(accessToken, updatedAfter, cursor) {
      session(accessToken);
      const after: [number, string] = cursor ? JSON.parse(cursor) : [updatedAfter.getTime(), ''];
      const page = [...sàn.orders]
        .filter(([id, t]) => t > after[0] || (t === after[0] && id > after[1]))
        .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
        .slice(0, PAGE);
      const last = page.at(-1);
      return {
        orders: page.map(([id, t]) => ({ externalOrderId: id, placedAt: new Date(t), updatedAt: new Date(t) })),
        nextCursor: page.length === PAGE && last ? JSON.stringify([last[1], last[0]]) : null,
        safeUntil: null,
      };
    },
  };
}
