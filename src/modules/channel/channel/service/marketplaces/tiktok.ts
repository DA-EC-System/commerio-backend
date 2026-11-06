// Adapter TikTok Shop (#217): uỷ quyền, gian hàng, SKU. Gọi sàn qua `tiktok-client.ts` (ký, gói cipher, đổi lỗi).
// Nguồn (docv2, tra 06/11/2026): authorization-overview-202407, get-authorized-shops-202309, search-products-202502;
// kết quả gọi thật ở commerio-backend#217 mục "Kết quả gọi thật" và Documents/tich-hop-san/tiktok.md.
//
// Thêm năng lực (đơn và kiện #221, tồn giá ẩn hiện #226, huỷ trả #227): viết file riêng `tiktok-<việc>.ts` export
// `tiktok<Việc>Methods(client: TiktokClient): Pick<MarketplaceAdapter, ...>`, gọi sàn bằng `client.call(method, path,
// { query, body, token })` với `token` là `TokenSet.accessToken` (client tự đặt header và `shop_cipher`), rồi spread vào
// đối tượng trả về ở `createTiktokAdapter` dưới đây và bỏ hàm `unsupported` tương ứng.
import {
  type MarketplaceAdapter,
  MarketplaceError,
  refreshBefore,
  type RemoteSku,
  type RemoteState,
  type ShopCapabilities,
  type ShopConnection,
  type TokenSet,
} from './common.ts';
import { tiktokListingMethods } from './tiktok-listing.ts';
import {
  createTiktokClient,
  packTiktokToken,
  type TiktokConfig,
  unpackTiktokToken,
} from './tiktok-client.ts';
import { tiktokOrderMethods } from './tiktok-orders.ts';
import { tiktokReturnMethods } from './tiktok-returns.ts';

export type { TiktokClient, TiktokConfig } from './tiktok-client.ts';

/** Link uỷ quyền seller bản ROW (gồm VN); không gửi `redirect_uri`, TikTok dùng Redirect URL khai trong app. */
const AUTHORIZE_URL = 'https://services.tiktokshop.com/open/authorize';

/**
 * Documents/21 §18.4, tich-hop-san/tiktok.md §2: sản phẩm mới qua duyệt (`PENDING`), ẩn bằng
 * `POST /product/202309/products/deactivate`, VN chỉ tách kiện theo SKU, hết hạn trả khi đơn sang `COMPLETED`.
 */
const TIKTOK_CAPABILITIES: ShopCapabilities = { listingReview: true, hideBy: 'deactivate', splitLevel: 'sku', returnWindow: 'platform_status' };

// Search Products 202502: `page_size` 1–100; `seller_skus` tối đa 10 (mã 12019027); tổng kết quả không quá 10000
// (mã 12052180). docv2 search-products-202502, tra 06/11/2026; bản mới nhất trên docv2 ngày đó là 202502.
const PRODUCT_PAGE = 100;
const SELLER_SKU_BATCH = 10;
const MAX_PRODUCTS = 10_000;
// Một lần lật quá số trang này là sàn trả con trỏ lặp: dừng, không lặp vô hạn.
const MAX_PAGES = MAX_PRODUCTS / PRODUCT_PAGE + 5;

type Row = Record<string, unknown>;

interface RawTokens {
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
}

/** `access_token_expire_in`, `refresh_token_expire_in` là **mốc Unix tuyệt đối** (giây), không phải số giây còn lại. */
/**
 * Làm mới khi access còn dưới 48 giờ (#201). Access TikTok sống 7 ngày (authorization-overview-202407): ngưỡng 48 giờ cho
 * việc nền mỗi giờ khoảng 48 lượt thử nếu sàn lỗi tạm, mà mỗi gian hàng chỉ làm mới khoảng 5 ngày một lần. 24 giờ cũng đủ
 * nhưng hở ít hơn khi sàn bảo trì dài.
 */
const REFRESH_LEAD_MS = 48 * 3_600_000;

const unixDate = (v: unknown) => (Number(v) > 0 ? new Date(Number(v) * 1000) : null);

function rawTokens(data: unknown): RawTokens {
  const d = (data ?? {}) as Row;
  if (typeof d.access_token !== 'string' || !d.access_token) throw new MarketplaceError('rejected', 'no_access_token');
  return {
    accessToken: d.access_token,
    refreshToken: typeof d.refresh_token === 'string' && d.refresh_token ? d.refresh_token : null,
    accessExpiresAt: unixDate(d.access_token_expire_in),
    refreshExpiresAt: unixDate(d.refresh_token_expire_in),
  };
}

/** Gói token thô của một lần uỷ quyền cho một gian hàng (cipher, mã shop). */
function packFor(raw: RawTokens, cipher: string, shopId: string): TokenSet {
  return {
    accessToken: packTiktokToken({ token: raw.accessToken, cipher, shopId }),
    refreshToken: raw.refreshToken && packTiktokToken({ token: raw.refreshToken, cipher, shopId }),
    accessExpiresAt: raw.accessExpiresAt,
    refreshExpiresAt: raw.refreshExpiresAt,
  };
}

/**
 * Trạng thái sản phẩm (`status` của Search Products) và SKU (`status_info`) → trạng thái chuẩn. Search Products không trả
 * lý do từ chối nên `rejectReason` null.
 */
export function tiktokRemoteState(productStatus: string, sku: Row): RemoteState {
  const info = (sku.status_info ?? {}) as Row;
  switch (productStatus) {
    case 'DELETED':
      return 'deleted';
    case 'FREEZE':
    case 'PLATFORM_DEACTIVATED':
      return 'hold';
    case 'FAILED':
      return 'rejected';
    case 'PENDING':
      return 'review';
    case 'ACTIVATE':
      if (info.status === 'DEACTIVATED') return info.deactivation_source === 'SELLER' ? 'inactive' : 'hold';
      return 'live';
    default:
      // DRAFT, SELLER_DEACTIVATED, giá trị lạ.
      return 'inactive';
  }
}

function skusOf(p: Row): RemoteSku[] {
  const status = String(p.status ?? '');
  return ((p.skus ?? []) as Row[]).map((s) => ({
    externalProductId: String(p.id),
    externalSkuId: String(s.id),
    sellerSku: typeof s.seller_sku === 'string' ? s.seller_sku : '',
    title: typeof p.title === 'string' ? p.title : '',
    state: tiktokRemoteState(status, s),
    rejectReason: null,
    // Tổng tồn ở các kho của SKU (`inventory[].quantity`).
    quantity: ((s.inventory ?? []) as Row[]).reduce((sum, i) => sum + (Number(i.quantity) || 0), 0),
  }));
}

export function createTiktokAdapter(config: TiktokConfig, fetchFn: typeof fetch = fetch): MarketplaceAdapter {
  const client = createTiktokClient(config, fetchFn);
  const oauthReady = client.hasCredentials && Boolean(config.serviceId);

  const refreshRaw = async (refreshToken: string): Promise<RawTokens> => {
    try {
      return rawTokens(await client.callAuth('/api/v2/token/refresh', { refresh_token: refreshToken, grant_type: 'refresh_token' }));
    } catch (err) {
      // Docs không liệt kê mã lỗi của refresh (gọi thật 06/11/2026: refresh token sai → 36004005 "can not find related auth
      // record"): sàn từ chối refresh token (hết hạn, bị thu hồi) thì gian hàng phải nối lại.
      if (err instanceof MarketplaceError && err.kind === 'rejected') throw new MarketplaceError('unauthorized', err.platformCode, err.platformMessage);
      throw err;
    }
  };

  /** Mọi gian hàng của token (Get Authorized Shops 202309; không gửi `shop_cipher`), mỗi gian hàng một token gói cipher. */
  async function connections(raw: RawTokens): Promise<ShopConnection[]> {
    const data = await client.callRaw<{ shops?: Row[] }>('GET', '/authorization/202309/shops', raw.accessToken);
    return (data?.shops ?? []).map((s) => {
      if (typeof s.id !== 'string' || typeof s.cipher !== 'string' || !s.cipher) throw new MarketplaceError('rejected', 'unexpected_response');
      const region = typeof s.region === 'string' && /^[A-Za-z]{2}$/.test(s.region) ? s.region.toUpperCase() : null;
      return { externalShopId: s.id, shopName: typeof s.name === 'string' ? s.name : '', region, tokens: packFor(raw, s.cipher, s.id) };
    });
  }

  async function exchangeCode(params: Readonly<Record<string, string>>): Promise<ShopConnection[]> {
    // Seller từ chối: `code=null&error=auth_denied` (authorization-overview-202407).
    if (params.error) throw new MarketplaceError('rejected', params.error, 'Seller không đồng ý uỷ quyền');
    const code = params.code;
    if (!code || code === 'null') throw new MarketplaceError('rejected', 'missing_parameter', 'Thiếu code trên URL callback');
    if (params.app_key && config.appKey && params.app_key !== config.appKey) {
      throw new MarketplaceError('rejected', 'app_key_mismatch', 'URL callback không phải của app TikTok này');
    }
    // `code` hạn 30 phút, dùng một lần; để vài phút rồi mới đổi từng gặp 36004004 (gọi thật 02/11/2026): đổi ngay.
    const raw = rawTokens(await client.callAuth('/api/v2/token/get', { auth_code: code, grant_type: 'authorized_code' }));
    return connections(raw);
  }

  /** Lật Search Products tới hết; `filter` là body lọc (luôn khác rỗng để chuỗi ký và body gửi đi giống nhau). */
  async function searchSkus(accessToken: string, filter: Row): Promise<RemoteSku[]> {
    const out: RemoteSku[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await client.call<{ products?: Row[]; next_page_token?: unknown; total_count?: unknown }>(
        'POST',
        '/product/202502/products/search',
        { token: accessToken, query: { page_size: PRODUCT_PAGE, page_token: pageToken }, body: filter },
      );
      if (page === 0 && Number(data?.total_count ?? 0) > MAX_PRODUCTS) {
        throw new MarketplaceError('rejected', 'too_many_products', `Gian hàng có hơn ${MAX_PRODUCTS} sản phẩm, sàn không cho đọc hết`);
      }
      const products = data?.products ?? [];
      out.push(...products.flatMap(skusOf));
      const next = typeof data?.next_page_token === 'string' ? data.next_page_token : '';
      if (!next || products.length === 0 || next === pageToken) return out;
      pageToken = next;
    }
    throw new MarketplaceError('rejected', 'too_many_pages', 'Sàn trả quá nhiều trang sản phẩm');
  }

  return {
    name: 'TikTok Shop',
    capabilities: TIKTOK_CAPABILITIES,
    connectMethods() {
      // OAuth cần `service_id` cho link uỷ quyền; dán token chỉ cần key, secret.
      return oauthReady ? ['oauth', 'token'] : client.hasCredentials ? ['token'] : [];
    },
    authorizeUrl(state) {
      if (!oauthReady) throw new MarketplaceError('unsupported');
      return `${AUTHORIZE_URL}?${new URLSearchParams({ service_id: config.serviceId!, state })}`;
    },
    exchangeCode,
    async connectWithToken({ accessToken, refreshToken }) {
      if (!client.hasCredentials) throw new MarketplaceError('unsupported');
      // Có refresh token thì làm mới một lần để biết hạn; không có thì hạn để trống, hết hạn thì dán token mới.
      const raw: RawTokens = refreshToken
        ? await refreshRaw(refreshToken)
        : { accessToken, refreshToken: null, accessExpiresAt: null, refreshExpiresAt: null };
      return connections(raw);
    },
    // `authExpiresAt` để trống: TikTok không trả hạn uỷ quyền riêng, `refresh_token_expire_in` đã là hạn đó.
    refreshDueAt: (tokens) => refreshBefore(tokens, REFRESH_LEAD_MS),
    async refreshToken(refreshToken) {
      // Làm mới không trả cipher: giữ cipher, mã shop trong chuỗi refresh đã gói.
      const parts = unpackTiktokToken(refreshToken);
      return packFor(await refreshRaw(parts.token), parts.cipher, parts.shopId);
    },
    // Mọi SKU của gian hàng cho gợi ý ghép lúc thiết lập (#198): mã sản phẩm, mã SKU sàn, SKU người bán; bỏ sản phẩm đã xoá.
    async listSkus(accessToken) {
      return (await searchSkus(accessToken, { status: 'ALL' })).filter((s) => s.state !== 'deleted');
    },
    async getSkus(accessToken, sellerSkus) {
      const wanted = new Set(sellerSkus);
      const out: RemoteSku[] = [];
      for (let i = 0; i < sellerSkus.length; i += SELLER_SKU_BATCH) {
        const batch = sellerSkus.slice(i, i + SELLER_SKU_BATCH);
        out.push(...(await searchSkus(accessToken, { status: 'ALL', seller_skus: batch })).filter((s) => wanted.has(s.sellerSku)));
      }
      return out;
    },
    // Tồn, giá, ẩn hiện (#226), danh mục và đăng sản phẩm (#219): `tiktok-listing.ts`.
    ...tiktokListingMethods(client),
    ...tiktokReturnMethods(client),
    ...tiktokOrderMethods(client),
  };
}

/** Cho các file `tiktok-<việc>.ts` tạo client cùng cấu hình khi dựng adapter. */
export { createTiktokClient };
