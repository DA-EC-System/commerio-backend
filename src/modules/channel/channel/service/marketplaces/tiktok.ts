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
  type RemoteCounts,
  type RemoteSku,
  type RemoteState,
  type ShopCapabilities,
  type ShopConnection,
  type TokenSet,
} from './common.ts';
import { logger } from '../../../../../shared/logger.ts';
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
// Trần sản phẩm đọc chi tiết (nhãn biến thể, ảnh) mỗi lần mở thiết lập: đọc 5 req/s mỗi gian hàng nên 50 lần ≈ 10 giây.
// Chỉ tính sản phẩm phải gọi sàn: sản phẩm ghép được theo SKU và sản phẩm đã có trong bộ nhớ đệm không tiêu trần.
const DETAIL_PRODUCT_MAX = 50;
// Số lời gọi Get Product chạy cùng lúc. Bộ giãn `TIKTOK_RATE_LIMIT` vẫn giữ 5 req/s mỗi gian hàng; chạy song song chỉ để
// thời gian chờ mạng của các lời gọi chồng lên nhau (gọi lần lượt thì mỗi lần mất trọn một vòng mạng).
const DETAIL_CONCURRENCY = 5;
// Bộ nhớ đệm chi tiết theo (gian hàng, sản phẩm), đúng khi `update_time` của Search Products không đổi: mở lại bước thiết
// lập không gọi lại sàn. Giữ trong tiến trình, tối đa 30 phút và 5000 sản phẩm (bỏ mục cũ nhất).
const DETAIL_CACHE_MS = 30 * 60_000;
const DETAIL_CACHE_MAX = 5000;
// Mã `rejected` không gắn với một sản phẩm (common-errors): 105005 thiếu scope, 106001 sai chữ ký, 36009004 sai
// `shop_cipher`. Gặp là mọi Get Product đều hỏng như nhau: dừng đọc nhãn ngay.
const LABEL_STOP_CODES = new Set(['105005', '106001', '36009004']);

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

/**
 * Mã lỗi của `/api/v2/token/refresh` nghĩa là refresh token, uỷ quyền không còn (gian hàng phải nối lại). docv2
 * common-errors (tra 07/11/2026) chỉ có nhóm 36004xxx cho `auth_code` (36004004), không liệt kê mã của refresh; danh sách
 * này theo quan sát: 36004005 "can not find related auth record" (gọi thật 06/11/2026, refresh token sai hoặc bị thu hồi),
 * 36004001 "rt has expired" (FAQ docv2 "The API /api/token/refreshtoken reports an error 36004001").
 */
const REFRESH_AUTH_CODES = new Set(['36004001', '36004005']);

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
 * Lý do sàn từ chối sản phẩm trong phản hồi Get Product 202309 (`audit_failed_reasons[]`, OAS của skill
 * `tts-openapi-guide`): mỗi mục nối `reasons` rồi `suggestions`, các mục cách nhau "; ". Không có câu nào thì null (#219).
 */
export function tiktokAuditReason(detail: unknown): string | null {
  const items = ((detail as Row | undefined)?.audit_failed_reasons ?? []) as Row[];
  const texts = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : []);
  const parts = (Array.isArray(items) ? items : []).map((i) => [...texts(i.reasons), ...texts(i.suggestions)].join(': ')).filter(Boolean);
  return parts.length ? parts.join('; ') : null;
}

/**
 * Trạng thái sản phẩm (`status` của Search Products) và SKU (`status_info`) → trạng thái chuẩn. Search Products không trả
 * lý do từ chối: `getSkus` đọc thêm Get Product cho sản phẩm bị từ chối (`tiktokAuditReason`).
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

/** Chi tiết đọc bằng Get Product: `labels` mã SKU → nhãn biến thể, `images` mã sản phẩm → URL ảnh đầu tiên. */
interface ProductDetails {
  labels: Map<string, string>;
  images: Map<string, string>;
}

/**
 * Sản phẩm nhiều SKU thì tiêu đề mỗi SKU là "tên sản phẩm - nhãn" để bảng ghép phân biệt được (#282); thiếu nhãn thì dùng
 * SKU người bán, rồi mã SKU sàn. `imageUrl`: ảnh đầu tiên của sản phẩm (`main_images[0].urls[0]` của Get Product), null
 * khi không đọc chi tiết.
 */
function skusOf(p: Row, details?: ProductDetails): RemoteSku[] {
  const status = String(p.status ?? '');
  const skus = (p.skus ?? []) as Row[];
  const title = typeof p.title === 'string' ? p.title : '';
  const imageUrl = details?.images.get(String(p.id)) ?? null;
  return skus.map((s) => {
    const sellerSku = typeof s.seller_sku === 'string' ? s.seller_sku : '';
    const variantLabel = details?.labels.get(String(s.id)) ?? null;
    const quantity = ((s.inventory ?? []) as Row[]).reduce((sum, i) => sum + (Number(i.quantity) || 0), 0);
    return {
      externalProductId: String(p.id),
      externalSkuId: String(s.id),
      sellerSku,
      title: skus.length > 1 ? `${title} - ${variantLabel || sellerSku || String(s.id)}` : title,
      variantLabel,
      imageUrl,
      state: tiktokRemoteState(status, s),
      rejectReason: null,
      // Tổng tồn ở các kho của SKU (`inventory[].quantity`).
      quantity,
      // "The SKU quantity available in the warehouse": cùng nghĩa với số app đẩy, dùng để đối chiếu (#223).
      sellableQuantity: quantity,
    };
  });
}

export function createTiktokAdapter(config: TiktokConfig, fetchFn: typeof fetch = fetch): MarketplaceAdapter {
  const client = createTiktokClient(config, fetchFn);
  const oauthReady = client.hasCredentials && Boolean(config.serviceId);

  const refreshRaw = async (refreshToken: string): Promise<RawTokens> => {
    try {
      return rawTokens(await client.callAuth('/api/v2/token/refresh', { refresh_token: refreshToken, grant_type: 'refresh_token' }));
    } catch (err) {
      if (!(err instanceof MarketplaceError) || err.kind === 'unavailable' || err.kind === 'unsupported') throw err;
      // Chỉ mã đã biết là refresh token, uỷ quyền hỏng mới là mất uỷ quyền (gian hàng nối lại). Lỗi khác (sai app key,
      // secret, chữ ký, mã lạ) là lỗi cấu hình của app: giữ `rejected`, không đẩy mọi gian hàng sang `needs_reauth`.
      const code = err.platformCode ?? '';
      if (REFRESH_AUTH_CODES.has(code)) throw new MarketplaceError('unauthorized', code, err.platformMessage);
      throw new MarketplaceError('rejected', err.platformCode, err.platformMessage);
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
    return (await searchProducts(accessToken, filter)).flatMap((p) => skusOf(p));
  }

  /** Chi tiết đã đọc của một sản phẩm: nhãn theo mã SKU, ảnh đầu tiên. */
  interface ProductDetail {
    labels: [string, string][];
    image: string | null;
  }
  const detailCache = new Map<string, { updateTime: string; at: number; detail: ProductDetail }>();
  const cacheKey = (shopId: string, p: Row) => `${shopId}:${String(p.id)}`;
  const updateTimeOf = (p: Row) => String(p.update_time ?? '');
  function cached(shopId: string, p: Row): ProductDetail | undefined {
    const hit = detailCache.get(cacheKey(shopId, p));
    if (!hit || hit.updateTime !== updateTimeOf(p) || Date.now() - hit.at > DETAIL_CACHE_MS) return undefined;
    return hit.detail;
  }
  function remember(shopId: string, p: Row, detail: ProductDetail) {
    const key = cacheKey(shopId, p);
    detailCache.delete(key);
    detailCache.set(key, { updateTime: updateTimeOf(p), at: Date.now(), detail });
    while (detailCache.size > DETAIL_CACHE_MAX) detailCache.delete(detailCache.keys().next().value!);
  }

  /** Nhãn biến thể, ảnh đầu tiên trong phản hồi Get Product. */
  function parseDetail(detail: { skus?: Row[]; main_images?: Row[] } | undefined): ProductDetail {
    const first = (detail?.main_images ?? [])[0]?.urls;
    const url = Array.isArray(first) ? first[0] : undefined;
    const labels: [string, string][] = [];
    for (const s of detail?.skus ?? []) {
      const label = ((s.sales_attributes ?? []) as Row[])
        .map((a) => (typeof a.value_name === 'string' ? a.value_name.trim() : ''))
        .filter(Boolean)
        .join(', ');
      if (label) labels.push([String(s.id), label]);
    }
    return { labels, image: typeof url === 'string' && url ? url : null };
  }

  /**
   * Chi tiết sản phẩm cho bước ghép: Search Products không trả `sales_attributes` và ảnh, phải gọi Get Product 202309 từng
   * sản phẩm (docv2 get-product-202309, tra 09/11/2026; chưa có bản mới hơn). Nhãn biến thể lấy từ
   * `skus[].sales_attributes[].value_name`, ảnh là `main_images[0].urls[0]`.
   *
   * Không gọi cho sản phẩm mà mọi SKU có SKU người bán trong `skipSellerSkus` (bên gọi ghép theo SKU được, nhãn không đổi
   * gợi ý), và cho sản phẩm đã có trong bộ nhớ đệm cùng `update_time`. Phần còn lại gọi tối đa `DETAIL_PRODUCT_MAX` sản
   * phẩm, `DETAIL_CONCURRENCY` lời gọi cùng lúc, sản phẩm nhiều SKU trước (nhãn đổi được gợi ý ghép, ảnh chỉ để nhìn), rồi
   * sản phẩm một SKU theo thứ tự sàn trả; sản phẩm còn lại, hoặc sàn từ chối đọc (vd vừa xoá), dùng SKU người bán làm nhãn
   * và không có ảnh. Chi tiết chỉ để hiển thị và ghép theo tên nên lỗi không làm hỏng bước ghép: lỗi của từng sản phẩm thì
   * bỏ qua sản phẩm đó; lỗi chung (mã trong `LABEL_STOP_CODES`, cùng một mã hai lần liền, sàn lỗi tạm) thì không gọi thêm
   * (lời gọi đang chạy vẫn chạy nốt); có lỗi thì ghi một dòng log tổng. Mất uỷ quyền thì ném. Get Product không trả sản
   * phẩm `FREEZE`, `DELETED` (OAS get-product-202309): không gọi.
   */
  async function productDetails(
    accessToken: string,
    products: readonly Row[],
    skipSellerSkus?: ReadonlySet<string>,
  ): Promise<ProductDetails> {
    const shopId = unpackTiktokToken(accessToken).shopId;
    const labels = new Map<string, string>();
    const images = new Map<string, string>();
    const apply = (p: Row, d: ProductDetail) => {
      if (d.image) images.set(String(p.id), d.image);
      for (const [skuId, label] of d.labels) labels.set(skuId, label);
    };
    const isMulti = (p: Row) => ((p.skus ?? []) as Row[]).length > 1;
    const matchedBySku = (p: Row) => {
      if (!skipSellerSkus) return false;
      const skus = (p.skus ?? []) as Row[];
      return skus.length > 0 && skus.every((s) => typeof s.seller_sku === 'string' && skipSellerSkus.has(s.seller_sku));
    };
    const toRead: Row[] = [];
    for (const p of products) {
      if (p.status === 'FREEZE' || p.status === 'DELETED' || matchedBySku(p)) continue;
      const hit = cached(shopId, p);
      if (hit) apply(p, hit);
      else toRead.push(p);
    }
    const picked = [...toRead.filter(isMulti), ...toRead.filter((p) => !isMulti(p))].slice(0, DETAIL_PRODUCT_MAX);
    const codes: Record<string, number> = {};
    let failed = 0;
    let lastCode: string | null = null;
    let stoppedBy: string | null = null;
    let fatal: { err: unknown } | null = null;
    let next = 0;
    const worker = async () => {
      while (next < picked.length && stoppedBy === null && fatal === null) {
        const p = picked[next++]!;
        try {
          const detail = parseDetail(
            await client.call('GET', `/product/202309/products/${encodeURIComponent(String(p.id))}`, { token: accessToken }),
          );
          lastCode = null;
          apply(p, detail);
          remember(shopId, p, detail);
        } catch (err) {
          if (!(err instanceof MarketplaceError) || (err.kind !== 'rejected' && err.kind !== 'unavailable')) {
            fatal ??= { err };
            return;
          }
          const code = err.platformCode ?? err.kind;
          failed += 1;
          codes[code] = (codes[code] ?? 0) + 1;
          if (err.kind === 'unavailable' || LABEL_STOP_CODES.has(code) || code === lastCode) stoppedBy ??= code;
          lastCode = code;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, picked.length) }, worker));
    if (fatal) throw (fatal as { err: unknown }).err;
    if (failed) {
      logger.warn(
        { externalShopId: shopId, products: picked.length, failed, codes, stoppedBy },
        'Không đọc được chi tiết sản phẩm TikTok, dùng SKU người bán làm nhãn, không có ảnh',
      );
    }
    return { labels, images };
  }

  /**
   * Một trang Search Products 202502. `totalCount` là số **sản phẩm** khớp `filter` (không phải số SKU), null khi sàn không
   * trả số. `listed`: `data` là object và có `products` dạng mảng (kể cả rỗng); false thì `products` trả ra là `[]` thay thế.
   */
  async function searchPage(
    accessToken: string,
    filter: Row,
    pageSize: number,
    pageToken?: string,
  ): Promise<{ products: Row[]; next: string; totalCount: number | null; listed: boolean }> {
    const res = await client.call<unknown>('POST', '/product/202502/products/search', {
      token: accessToken,
      query: { page_size: pageSize, page_token: pageToken },
      body: filter,
    });
    const data = (typeof res === 'object' && res !== null && !Array.isArray(res) ? res : {}) as {
      products?: unknown;
      next_page_token?: unknown;
      total_count?: unknown;
    };
    const listed = Array.isArray(data.products);
    const raw = data.total_count;
    const total = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
    return {
      products: listed ? (data.products as Row[]) : [],
      next: typeof data.next_page_token === 'string' ? data.next_page_token : '',
      totalCount: Number.isSafeInteger(total) && total >= 0 ? total : null,
      listed,
    };
  }

  async function searchProducts(accessToken: string, filter: Row): Promise<Row[]> {
    const out: Row[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { products, next, totalCount } = await searchPage(accessToken, filter, PRODUCT_PAGE, pageToken);
      if (page === 0 && (totalCount ?? 0) > MAX_PRODUCTS) {
        throw new MarketplaceError('rejected', 'too_many_products', `Gian hàng có hơn ${MAX_PRODUCTS} sản phẩm, sàn không cho đọc hết`);
      }
      out.push(...products);
      if (!next || products.length === 0) return out;
      // Sàn trả lại con trỏ vừa gửi: đọc tiếp sẽ lặp, dừng thì trả thiếu. Báo lỗi như gian hàng quá giới hạn (hợp đồng
      // `listSkus`: không trả thiếu).
      if (next === pageToken) throw new MarketplaceError('rejected', 'page_token_repeated', 'Sàn trả lại trang sản phẩm vừa đọc');
      pageToken = next;
    }
    throw new MarketplaceError('rejected', 'too_many_pages', 'Sàn trả quá nhiều trang sản phẩm');
  }

  /**
   * Số sản phẩm và số SKU trên sàn lúc nối (§18.7.4), không lật hết trang. Search Products chỉ trả `total_count` (số sản
   * phẩm khớp điều kiện lọc), không có tổng số SKU (docv2 search-products-202502 và OAS, tra 11/11/2026).
   *
   * Gọi trang đầu (`status: ALL`, 100 sản phẩm). `total_count` không quá số sản phẩm của trang thì trang đã chứa hết gian
   * hàng: đếm sản phẩm và SKU khác `DELETED` ngay trên trang, một lời gọi. Không xét `next_page_token`: sàn trả token
   * khác rỗng cả khi đã hết (gọi thật 09/11/2026). Nhiều hơn một trang thì `skuCount` null (không đọc tiếp), và số sản
   * phẩm = `total_count` của `ALL` trừ `total_count` của `DELETED` (lời gọi thứ hai, `page_size` 1), vì `ALL` có tính sản
   * phẩm đã xoá: gọi thật 11/11/2026 trên shop thử VN, `ALL` 5 = `ACTIVATE` 2 + `DELETED` 3, `DELETED` 3.
   *
   * Không ném `too_many_products`: gian hàng hơn 10000 sản phẩm vẫn có `total_count`. Sàn không trả `total_count` dạng số
   * mà trang đầu chưa đầy thì coi trang là hết; trang đầy thì `rejected` `unexpected_response`, không đoán số.
   *
   * Phản hồi thành công mà không có gì để đếm (`data` vắng hoặc không phải object, hoặc không có cả `total_count` dạng số
   * lẫn `products` dạng mảng), ở lời gọi nào cũng `rejected` `unexpected_response`: 0 chỉ khi sàn trả tổng 0 hoặc danh
   * sách rỗng (§18.7.4, không trả 0 thay cho lỗi). `skus` của một sản phẩm không phải mảng thì sản phẩm đó tính 0 SKU.
   */
  async function countRemote(accessToken: string): Promise<RemoteCounts> {
    const first = await searchPage(accessToken, { status: 'ALL' }, PRODUCT_PAGE);
    if (first.totalCount === null && (!first.listed || first.products.length >= PRODUCT_PAGE)) {
      throw new MarketplaceError('rejected', 'unexpected_response');
    }
    if (first.totalCount === null || first.totalCount <= first.products.length) {
      const live = first.products.filter((p) => p.status !== 'DELETED');
      return { productCount: live.length, skuCount: live.reduce((sum, p) => sum + (Array.isArray(p.skus) ? p.skus.length : 0), 0) };
    }
    const deleted = await searchPage(accessToken, { status: 'DELETED' }, 1);
    if (deleted.totalCount === null && (!deleted.listed || deleted.products.length > 0)) {
      throw new MarketplaceError('rejected', 'unexpected_response');
    }
    return { productCount: Math.max(0, first.totalCount - (deleted.totalCount ?? 0)), skuCount: null };
  }

  // `status: ALL` gồm cả sản phẩm đã xoá (gọi thật 11/11/2026, mục `countRemote`), nên SKU đã xoá trả `deleted`.
  // Sản phẩm bị từ chối: đọc Get Product từng sản phẩm để lấy lý do (#219); sàn từ chối đọc hay lỗi tạm thì để null (bên
  // gọi ghi câu mặc định), mất uỷ quyền thì ném.
  async function getSkus(accessToken: string, sellerSkus: readonly string[]): Promise<RemoteSku[]> {
    const wanted = new Set(sellerSkus);
    const out: RemoteSku[] = [];
    for (let i = 0; i < sellerSkus.length; i += SELLER_SKU_BATCH) {
      const batch = sellerSkus.slice(i, i + SELLER_SKU_BATCH);
      out.push(...(await searchSkus(accessToken, { status: 'ALL', seller_skus: batch })).filter((s) => wanted.has(s.sellerSku)));
    }
    const reasons = new Map<string, string | null>();
    for (const productId of new Set(out.filter((s) => s.state === 'rejected').map((s) => s.externalProductId))) {
      try {
        reasons.set(productId, tiktokAuditReason(await client.call('GET', `/product/202309/products/${encodeURIComponent(productId)}`, { token: accessToken })));
      } catch (err) {
        if (!(err instanceof MarketplaceError) || (err.kind !== 'rejected' && err.kind !== 'unavailable')) throw err;
      }
    }
    return out.map((s) => (reasons.get(s.externalProductId) ? { ...s, rejectReason: reasons.get(s.externalProductId)! } : s));
  }

  /** SKU còn trên sàn (bỏ `deleted`) theo `seller_sku`, cho `createProduct` không tạo trùng. */
  const findSku = async (accessToken: string, sellerSku: string) =>
    (await getSkus(accessToken, [sellerSku])).find((s) => s.state !== 'deleted') ?? null;

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
    // Mọi SKU của gian hàng cho gợi ý ghép lúc thiết lập (#198, #282): mã sản phẩm, mã SKU sàn, SKU người bán, tiêu đề kèm
    // nhãn biến thể, ảnh đầu tiên; bỏ sản phẩm đã xoá. `labels: false` (hoàn tất bằng `decisions`) không
    // gọi Get Product: không nhãn, không ảnh. `skipSellerSkus`: sản phẩm ghép được theo SKU không đọc chi tiết.
    async listSkus(accessToken, opts) {
      const products = (await searchProducts(accessToken, { status: 'ALL' })).filter((p) => p.status !== 'DELETED');
      const details = opts?.labels === false ? undefined : await productDetails(accessToken, products, opts?.skipSellerSkus);
      return products.flatMap((p) => skusOf(p, details)).filter((s) => s.state !== 'deleted');
    },
    countRemote,
    getSkus,
    // Tồn, giá, ẩn hiện (#226), danh mục và đăng sản phẩm (#219): `tiktok-listing.ts`.
    ...tiktokListingMethods(client, { findSku }),
    ...tiktokReturnMethods(client),
    ...tiktokOrderMethods(client),
  };
}

/** Cho các file `tiktok-<việc>.ts` tạo client cùng cấu hình khi dựng adapter. */
export { createTiktokClient };
