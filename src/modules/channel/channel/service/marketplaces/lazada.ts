// Adapter Lazada Open Platform (Documents/tich-hop-san/lazada.md §2, §3, §7.1). Cách ký chép từ scripts/smoke/lazada.ts.
import { createHmac } from 'node:crypto';
import type { LedgerKind } from '../../../../finance/index.ts';
import {
  type CategoryAttribute,
  DEFAULT_REFRESH_LEAD_MS,
  type MarketplaceAdapter,
  MarketplaceError,
  type NewProduct,
  type Payout,
  partResults,
  type PerSkuResult,
  type PlatformCategory,
  type PriceQuantity,
  PROMOTION_LOCKED,
  type RemoteCounts,
  type RemoteLineInfo,
  type RemoteLineStatus,
  type RemoteOrder,
  type RemotePackageEvent,
  type RemoteSku,
  type RemoteState,
  refreshBefore,
  type SellerInfo,
  type ShopCapabilities,
  type ShopConnection,
  type SettlementTxn,
  type TokenSet,
} from './common.ts';
import { lazadaReturnMethods } from './lazada-returns.ts';

export interface LazadaConfig {
  appKey: string | undefined;
  appSecret: string | undefined;
  redirectUrl: string | undefined;
  apiUrl: string;
  authUrl: string;
  /** Xin một lượt trong hạn mức gọi của app trước mỗi request (#102 A7); `false` là hết lượt hôm nay. */
  reserveCall?: () => Promise<boolean>;
}

type LazadaResponse = Record<string, unknown> & { code?: string; message?: string; type?: string };

const TIMEOUT_MS = 10_000;
/** Documents/21 §18.6.3: Lazada duyệt listing, ẩn bằng tắt, tách kiện từng đơn vị, hạn trả tính theo ngày của gian hàng. */
const LAZADA_CAPABILITIES: ShopCapabilities = { listingReview: true, hideBy: 'deactivate', splitLevel: 'unit', returnWindow: 'days' };
// Mã token sai hoặc hết hạn (lazada.md §6): gian hàng cần nối lại, không thử lại.
const AUTH_CODES = new Set(['IllegalAccessToken', 'IllegalRefreshToken', 'InvalidCode', 'InvalidRefreshToken']);
// Mã số là lỗi nghiệp vụ dù mang type ISP (probe-104b), trừ mã lỗi tạm: nội bộ, gọi quá nhanh (tài liệu CreateProduct).
const TRANSIENT_NUMERIC = new Set(['6', '901', '1000', '4154']);
// UpdatePriceQuantity, UpdateSellableQuantity: tối đa 50 SKU một lần, Lazada khuyên 20.
const PRICE_QTY_BATCH = 20;
/**
 * Mã Lazada khi SKU đang trong chiến dịch (#223, 25 §6.5 bước 3): 4170 "During the Bday Mega campaign, there are
 * restrictions for stock adjustments in effect between YYYY-MM-DD HH:MM:SS - YYYY-MM-DD HH:MM:SS. Sellers can increase
 * stocks, but may not decrease stocks." Hướng xử lý của tài liệu: "This SKU is participating in a special Campaign, so this
 * SKU can't be updated to set stock less than current stock." (bảng mã UpdatePriceQuantity, UpdateSellableQuantity,
 * open.lazada.com, tra 12/11/2026). Bảng mã không có mã nào cho giá bị khoá do khuyến mãi.
 */
const LAZADA_PROMOTION_CODES = new Set(['4170']);
// GetProducts: `limit` tối đa 50; một sản phẩm một SKU (#104 A1). `offset` tối đa 10000 (open.lazada.com, tra 06/11/2026).
const SKU_LIST_BATCH = 50;
// GetMultipleOrderItems: "No more than 50 at a time" (open.lazada.com, tra 06/11/2026, #267).
const ORDER_ITEMS_BATCH = 50;
const MAX_PRODUCT_OFFSET = 10_000;
/** Sản phẩm Lazada sớm nhất có thể có (sàn mở năm 2012): đầu khoảng ngày tạo của lần đọc trọn. */
const LAZADA_EPOCH_MS = Date.UTC(2012, 0, 1);
/** Trần tuyệt đối số lời gọi một lần đọc trọn khi sàn không báo tổng; có tổng thì trần là ⌈tổng / 50⌉ × 10 + 64. */
const MAX_WINDOW_CALLS = 2_000;
const incomplete = (total: number, got: number) =>
  new MarketplaceError('rejected', 'incomplete_list', `Sàn báo ${total} sản phẩm nhưng chỉ trả ${got}, thử lại sau`);
// QueryTransactionDetails: mỗi lần tối đa 500 dòng, lật trang bằng `offset` (#117).
const TXN_PAGE = 500;

/** Chuỗi ký: apiPath + các cặp key+value xếp theo key; HMAC-SHA256 bằng app secret, hex viết hoa. */
export function signLazada(apiPath: string, params: Record<string, string>, secret: string): string {
  const base = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], apiPath);
  return createHmac('sha256', secret).update(base).digest('hex').toUpperCase();
}

/** Lỗi trong body (`code` khác "0") đổi sang loại của app. */
/**
 * Loại khoản trong sổ của một dòng quyết toán Lazada (lazada.md §7.6; chuyển từ finance ở #203). Theo tên phí và loại
 * giao dịch; chưa nhận ra thì `null` (finance ghi `adjustment` kèm tên phí). Bảng dựng theo tài liệu và sàn giả lập
 * #115: đối chiếu khi có dữ liệu thật.
 */
export function lazadaLedgerKind(feeName: string, transactionType: string): LedgerKind | null {
  const f = feeName.toLowerCase();
  const t = transactionType.toLowerCase();
  if (t.includes('payout') || t.includes('withdraw')) return 'withdrawal';
  if (f.startsWith('reversal item price') || f.includes('refund')) return 'customer_refund';
  if (f.includes('item price credit')) return 'revenue';
  if (f.includes('commission')) return 'fee_fixed';
  if (f.includes('payment fee')) return 'fee_transaction';
  if (f.includes('paid by customer')) return 'shipping_income';
  if (f.includes('shipping fee')) return 'shipping_cost';
  if (f.includes('handling fee') || f.includes('service fee') || f.includes('free shipping max') || f.includes('lazcoins')) {
    return 'fee_service';
  }
  if (t.includes('marketing') || f.includes('sponsored')) return 'ads';
  if (f.includes('lost') || f.includes('damaged') || f.includes('compensation') || f.includes('claim')) return 'lost_compensation';
  if (f.includes('penalty')) return 'penalty';
  if (f.includes('subsidy') || f.includes('platform voucher')) return 'platform_subsidy';
  return null;
}

/**
 * Mã giao dịch Lazada dạng "Seller code- xxxxxxx", khoảng trắng không cố định giữa các lần trả: bỏ khoảng trắng để
 * khoá chống trùng (gian hàng, mã giao dịch) so được (#250).
 */
export const normalizeLazadaTxnId = (raw: unknown): string => String(raw ?? '').replace(/\s+/g, '');

export function lazadaError(res: LazadaResponse): MarketplaceError {
  const code = String(res.code ?? 'unknown');
  const message = typeof res.message === 'string' ? res.message : null;
  if (AUTH_CODES.has(code)) return new MarketplaceError('unauthorized', code, message);
  // `SYSTEM`, `ISP` với mã chữ: lỗi phía sàn; `ApiCallLimit`, `SellerCallLimit`: quá hạn mức; đều thử lại được.
  const numeric = /^\d+$/.test(code);
  if (res.type === 'SYSTEM' || code === 'ApiCallLimit' || code === 'SellerCallLimit' || TRANSIENT_NUMERIC.has(code) || (res.type === 'ISP' && !numeric)) {
    return new MarketplaceError('unavailable', code, message);
  }
  return new MarketplaceError('rejected', code, message);
}

/** Thoát ký tự đặc biệt khi ghép vào payload XML. */
const xml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type LazadaProduct = {
  item_id?: unknown;
  status?: unknown;
  subStatus?: unknown;
  rejectReason?: { violationDetail?: unknown }[];
  attributes?: { name?: unknown };
  /** Giờ tạo, mili giây dạng chuỗi (gọi thật 12/11/2026): điểm chia của lần đọc trọn (review #309 vòng 5 C1). */
  created_time?: unknown;
  /** Ảnh sản phẩm: mảng URL (gọi thật 09/11/2026); ví dụ trên open.lazada.com ghi chuỗi JSON của mảng, đọc được cả hai. */
  images?: unknown;
  skus?: { SkuId?: unknown; SellerSku?: unknown; quantity?: unknown; sellableStock?: unknown; Images?: unknown }[];
};

/** URL đầu tiên khác rỗng của `images` (GetProducts): mảng chuỗi hoặc chuỗi JSON của mảng; không có thì null. */
function firstImage(images: unknown): string | null {
  let list = images;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(list)) return null;
  const url = list.find((u): u is string => typeof u === 'string' && u.trim() !== '');
  return url ? url.trim() : null;
}

/** Trạng thái sản phẩm Lazada (`status`, `subStatus`, `rejectReason` của GetProducts) → trạng thái chuẩn. */
function remoteState(p: LazadaProduct): { state: RemoteState; rejectReason: string | null } {
  const status = String(p.status ?? '');
  const reason =
    (p.rejectReason ?? [])
      .map((r) => String(r.violationDetail ?? ''))
      .filter(Boolean)
      .join('; ') || null;
  if (status === 'Deleted') return { state: 'deleted', rejectReason: null };
  if (status === 'Suspended' || String(p.subStatus ?? '').includes('Lock')) return { state: 'hold', rejectReason: null };
  if (reason && status !== 'Active') return { state: 'rejected', rejectReason: reason };
  if (status === 'Pending QC') return { state: 'review', rejectReason: null };
  if (status === 'Active') return { state: 'live', rejectReason: null };
  return { state: 'inactive', rejectReason: null };
}

/** `imageUrl` (#282): ảnh đầu tiên của sản phẩm (`images`), sản phẩm không có ảnh thì ảnh đầu của SKU (`skus[].Images`). */
function skusOf(p: LazadaProduct): RemoteSku[] {
  const { state, rejectReason } = remoteState(p);
  const productImage = firstImage(p.images);
  return (p.skus ?? []).map((s) => ({
    externalProductId: String(p.item_id),
    externalSkuId: String(s.SkuId),
    sellerSku: String(s.SellerSku ?? ''),
    title: String(p.attributes?.name ?? ''),
    imageUrl: productImage ?? firstImage(s.Images),
    state,
    rejectReason,
    quantity: Number(s.quantity ?? 0),
    // Số bán được để đối chiếu tồn (#223). Tài liệu GetProducts không định nghĩa trường nào trong `skus`, chỉ ghi tham số
    // `options`: "This value can be used to get more stock information. e.g., Options=1 means contain ReservedStock,
    // RtsStock, PendingStock, RealTimeStock, FulfillmentBySellable." (open.lazada.com, tra 12/11/2026). Gọi thật
    // `options=1` ngày 12/11/2026 trên shop thử (request_id d742e42a17944720668581466), 20 SKU: `quantity` = `Available`
    // = `sellableStock` = tổng `multiWarehouseInventories[].sellableQuantity` = tổng (`totalQuantity` − `occupyQuantity` −
    // `withholdQuantity`); 6 SKU có hàng bị đơn chiếm, vd tồn tổng 99, chiếm 2, `sellableStock` 97. App đẩy bằng
    // UpdateSellableQuantity nên so với `sellableStock`; thiếu trường thì không đối chiếu.
    ...(s.sellableStock !== undefined && s.sellableStock !== null && { sellableQuantity: Number(s.sellableStock) }),
  }));
}

const SELLER_LIMIT_WAIT_MS = 1100;
// GetOrders: `limit` tối đa 100.
const ORDER_PAGE = 100;

/**
 * Con trỏ kéo đơn (#218): mốc `update_after` (giây), offset trong mốc đó, đơn đã trả: `order_id` → giây `updated_at`.
 * `lastId`: đơn cuối trang trước khi đang lật offset; trang sau phải mở đầu bằng đơn này (gối một đơn).
 */
interface OrderCursor {
  after: number;
  offset: number;
  seen: Record<string, number>;
  lastId?: string;
}
const epochSec = (d: Date) => Math.floor(d.getTime() / 1000);
/**
 * Trạng thái đơn chưa xong của `/orders/get` (`status`, open.lazada.com tra 06/11/2026), theo thứ tự vòng đời: đơn đổi
 * trạng thái giữa lượt tiến sang trạng thái chưa đọc nên vẫn được đọc (#198 A8).
 */
const OPEN_STATUSES = ['unpaid', 'pending', 'topack', 'packed', 'toship', 'ready_to_ship', 'shipped', 'shipping'] as const;
/** Mốc `update_after` đầu của mỗi trạng thái: đủ xa để gồm mọi đơn còn mở (tài liệu không giới hạn khoảng ngày). */
const OPEN_ORDERS_FROM = Date.parse('2020-01-01T00:00:00+07:00') / 1000;
interface OpenOrderCursor {
  status: number;
  inner: OrderCursor;
}

// Trạng thái món của Lazada (20 giá trị của GetOrders) → trạng thái kiện của app (#105 A3).
const LINE_STATUS: Readonly<Record<string, RemoteLineStatus>> = {
  unpaid: 'pending',
  pending: 'pending',
  topack: 'pending',
  packed: 'packed',
  ready_to_ship: 'awaiting_pickup',
  toship: 'awaiting_pickup',
  shipped: 'in_transit',
  shipping: 'in_transit',
  delivered: 'delivered',
  failed_delivery: 'delivery_failed',
  failed: 'delivery_failed',
  shipped_back: 'returning',
  shipped_back_success: 'returned',
  returned: 'returned',
  shipped_back_failed: 'return_failed',
  lost: 'lost',
  lost_by_3pl: 'lost',
  damaged_by_3pl: 'lost',
  package_scrapped: 'lost',
  canceled: 'cancelled',
};

export const lazadaPackageStatus = (raw: string): RemoteLineStatus | null => LINE_STATUS[raw] ?? null;

/**
 * Hành trình kiện từ `result` của `/logistic/order/trace` (spec #199 phần c §5.7, lazada.md §7.4): mỗi
 * `module[].package_detail_info_list[]` (`ofc_package_id`, `tracking_number`), mỗi `logistic_detail_info_list[]` một mốc:
 * `detail_type` theo bảng trạng thái món, `event_time` mili giây, `description`. Dòng `detail_type` lạ hay `event_time`
 * không phải số dương thì bỏ (mốc là thông tin phụ). Module rỗng (đơn chưa sẵn sàng giao) trả `[]`.
 */
export function lazadaPackageEvents(result: unknown): RemotePackageEvent[] {
  const list = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  const out: RemotePackageEvent[] = [];
  for (const m of list((result as Record<string, unknown> | null | undefined)?.module)) {
    for (const p of list(m.package_detail_info_list)) {
      const packageCode = str(p.ofc_package_id) || null;
      const trackingCode = str(p.tracking_number) || null;
      for (const d of list(p.logistic_detail_info_list)) {
        const status = lazadaPackageStatus(str(d.detail_type));
        const time = typeof d.event_time === 'number' || typeof d.event_time === 'string' ? Number(d.event_time) : NaN;
        if (status === null || !Number.isFinite(time) || time <= 0) continue;
        out.push({ packageCode, trackingCode, status, at: new Date(time), description: str(d.description).trim() || null });
      }
    }
  }
  return out;
}

/** `2026-10-29 14:41:18 +0700` → Date. */
const lazadaTime = (value: unknown) => new Date(String(value).replace(' ', 'T').replace(/ ([+-]\d{2})(\d{2})$/, '$1:$2'));

/** Date → `2026-10-29T00:00:00+07:00`, dạng Lazada nhận ở `update_after`. */
const vnTime = (d: Date) => `${new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 19)}+07:00`;

/** Hạn giao chỉ có trong câu `fulfillment_sla` (shop thử để trống `sla_time_stamp`, #105 A10). */
function slaDeadline(text: unknown): Date | null {
  const m = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/.exec(String(text ?? ''));
  return m ? new Date(`${m[1]}T${m[2]}+07:00`) : null;
}

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
/** Chuỗi của sàn, trống thì null. */
const opt = (v: unknown) => str(v).trim() || null;

/** `2026-11-06 23:59:02 +0700` → Date; trống hoặc sai dạng là null. */
function optTime(v: unknown): Date | null {
  if (!opt(v)) return null;
  const d = lazadaTime(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const CANCEL_KIND: Readonly<Record<string, 'cancellation' | 'return' | 'refund'>> = { cancellation: 'cancellation', return: 'return', refund: 'refund' };
const CANCEL_BY: Readonly<Record<string, 'buyer' | 'seller' | 'platform'>> = { customer: 'buyer', seller: 'seller', internal: 'platform' };

/**
 * `cancel_return_initiator` dạng `<loại>-<người>` (GetOrderItems, đọc 05/11/2026): `cancellation-customer`, `return-customer`,
 * `refund-internal`… `cancellation-failed Delivery` là giao không thành, không ai huỷ. `null-null` và giá trị lạ → null.
 */
export function lazadaCancelSource(raw: string): Pick<RemoteLineInfo, 'cancelInitiator' | 'cancelKind'> {
  const [kind = '', ...rest] = raw.split('-');
  const who = rest.join('-');
  if (kind === 'cancellation' && who === 'failed Delivery') return { cancelInitiator: null, cancelKind: 'failed_delivery' };
  const k = CANCEL_KIND[kind];
  const by = CANCEL_BY[who];
  return k && by ? { cancelInitiator: by, cancelKind: k } : { cancelInitiator: null, cancelKind: null };
}

const ADDRESS_KEYS = ['address1', 'address2', 'address3', 'address4', 'address5', 'city', 'addressDistrict', 'post_code', 'country'] as const;

const toDate = (seconds: unknown) => (Number(seconds) > 0 ? new Date(Date.now() + Number(seconds) * 1000) : null);

type Row = Record<string, unknown>;

/** Đơn chuẩn hoá từ một đơn của `/order/get` (hoặc một phần tử `data.orders` của `/orders/get`) và các món của nó. */
function toRemoteOrder(o: Row, items: Row[]): RemoteOrder {
  // `/orders/get` lọc theo `status` chỉ trả trạng thái được lọc trong `statuses` (đo 06/11/2026, #267): trang đó bỏ
  // `statuses`, lấy trạng thái các món theo thứ tự món như `/order/get`.
  const statuses = Array.isArray(o.statuses) ? o.statuses.map(str) : [...new Set(items.map((i) => str(i.status)))];
  const a = (o.address_shipping ?? null) as Row | null;
  const deadlines = items.map((i) => slaDeadline(i.fulfillment_sla)).filter((d) => d !== null);
  return {
    externalOrderId: str(o.order_id),
    rawStatus: [...new Set(statuses)].join(','),
    paid: !statuses.includes('unpaid'),
    isCod: o.payment_method === 'COD',
    placedAt: lazadaTime(o.created_at),
    updatedAt: lazadaTime(o.updated_at),
    shipBy: deadlines.length ? new Date(Math.min(...deadlines.map((d) => d.getTime()))) : null,
    // Lazada che đường, tỉnh; `city` là phường (địa chỉ hai cấp), không còn quận (đo 05/11/2026, #260 A5); phường để ở `ward`, không lặp trong `address`.
    shippingAddress: a && {
      name: `${str(a.first_name)} ${str(a.last_name)}`.trim(),
      phone: str(a.phone),
      address: ['address1', 'address2', 'address3', 'address4', 'address5'].map((k) => str(a[k])).filter(Boolean).join(', '),
      ward: opt(a.city),
      postCode: opt(a.post_code),
      raw: Object.fromEntries(ADDRESS_KEYS.flatMap((k) => (opt(a[k]) ? [[k === 'post_code' ? 'postCode' : k, opt(a[k])!]] : []))),
    },
    shippingFee: str(o.shipping_fee ?? 0),
    // Mẫu response của GetOrders ghi hai cờ dạng chuỗi `"true"`; nhận cả boolean (review #267).
    cancelRequested: [o.is_cancel_pending, o.need_cancel_confirm].some((v) => v === true || v === 'true'),
    info: {
      platformPaymentMethod: opt(o.payment_method),
      buyerNote: opt(o.buyer_note),
      shippingFeeOriginal: opt(o.shipping_fee_original),
      shippingFeeDiscountSeller: opt(o.shipping_fee_discount_seller),
      shippingFeeDiscountPlatform: opt(o.shipping_fee_discount_platform),
    },
    lines: items.map((i) => ({
      externalLineId: str(i.order_item_id),
      sellerSku: str(i.sku),
      productName: str(i.name),
      unitPrice: str(i.item_price ?? 0),
      sellerDiscount: str(i.voucher_seller ?? 0),
      platformDiscount: str(i.voucher_platform ?? 0),
      packageCode: str(i.package_id) || null,
      trackingCode: str(i.tracking_code) || null,
      rawStatus: str(i.status),
      status: lazadaPackageStatus(str(i.status)),
      info: {
        thumbnailUrl: opt(i.product_main_image),
        attributesLabel: opt(i.variation),
        externalSkuId: opt(i.sku_id),
        externalShopSku: opt(i.shop_sku),
        // `/orders/items/get` không trả `product_id`; `shop_sku` mở đầu bằng mã sản phẩm (đo 06/11/2026, #267).
        externalProductId: opt(i.product_id) ?? /^(\d+)_/.exec(str(i.shop_sku))?.[1] ?? null,
        paidPrice: opt(i.paid_price),
        taxAmount: opt(i.tax_amount),
        shippingAmount: opt(i.shipping_amount),
        walletCredits: opt(i.wallet_credits),
        cancelReason: opt(i.reason),
        cancelReasonDetail: opt(i.reason_detail),
        ...lazadaCancelSource(str(i.cancel_return_initiator)),
        reverseOrderId: opt(i.reverse_order_id),
        returnStatus: opt(i.return_status),
      },
      shipping: {
        shipmentProvider: opt(i.shipment_provider),
        shippingProviderType: opt(i.shipping_provider_type),
        shippingType: opt(i.shipping_type),
        promisedShippingAt: optTime(i.promised_shipping_time),
      },
    })),
  };
}

export function createLazadaAdapter(config: LazadaConfig, fetchFn: typeof fetch = fetch): MarketplaceAdapter {
  // Một chỗ quyết định cấu hình đủ chưa: `connectMethods`, `credentials`, `authorizeUrl` cùng đọc (#163).
  const hasCredentials = Boolean(config.appKey && config.appSecret);
  const oauthReady = hasCredentials && Boolean(config.redirectUrl);

  function credentials() {
    if (!hasCredentials) throw new MarketplaceError('unsupported');
    return { appKey: config.appKey!, appSecret: config.appSecret! };
  }

  /**
   * Gọi sàn, trả body kể cả khi `code` khác "0". `FORM`: POST, mọi tham số trong form body (payload sản phẩm dài,
   * probe-104b R5); `POST` giữ tham số trên URL như lúc gọi thật ở #103.
   */
  async function request(baseUrl: string, apiPath: string, params: Record<string, string>, method: 'GET' | 'POST' | 'FORM') {
    const { appKey, appSecret } = credentials();
    if (config.reserveCall && !(await config.reserveCall())) {
      throw new MarketplaceError('unavailable', 'daily_call_limit', 'Đã dùng hết hạn mức gọi Lazada trong ngày');
    }
    const all = { app_key: appKey, timestamp: String(Date.now()), sign_method: 'sha256', ...params };
    const signed = new URLSearchParams({ ...all, sign: signLazada(apiPath, all, appSecret) });
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    let res: Response;
    try {
      res =
        method === 'FORM'
          ? await fetchFn(`${baseUrl}${apiPath}`, { method: 'POST', body: signed, signal })
          : await fetchFn(`${baseUrl}${apiPath}?${signed}`, { method, signal });
    } catch {
      throw new MarketplaceError('unavailable');
    }
    if (res.status >= 500 || res.status === 429) throw new MarketplaceError('unavailable', `http_${res.status}`);
    let body: LazadaResponse;
    try {
      body = (await res.json()) as LazadaResponse;
    } catch {
      throw new MarketplaceError('unavailable', `http_${res.status}`);
    }
    return body;
  }

  async function call(baseUrl: string, apiPath: string, params: Record<string, string>, method: 'GET' | 'POST' | 'FORM') {
    let body = await request(baseUrl, apiPath, params, method);
    // Gọi dồn thì Lazada khoá seller 1 giây (`SellerCallLimit`, gọi thật #105): chờ rồi gọi lại một lần.
    if (body.code === 'SellerCallLimit') {
      await new Promise((r) => setTimeout(r, SELLER_LIMIT_WAIT_MS));
      body = await request(baseUrl, apiPath, params, method);
    }
    if (body.code !== '0') throw lazadaError(body);
    return body;
  }

  /**
   * Một lô cập nhật giá (`/product/price_quantity/update`, chỉ gửi `<Price>`) hoặc tồn (`/product/stock/sellable/update`,
   * `<SellableQuantity>`). Tồn đi UpdateSellableQuantity (#223, chốt 12/11/2026): tài liệu ghi rõ "Use this API to update
   * sellable quantity of one or more existing products", khớp số app đẩy (số có thể bán); UpdatePriceQuantity chỉ ghi
   * "Use this API to update the price and quantity of one or more existing products", không nói `<Quantity>` là tồn tổng
   * hay số bán được. Chưa thử ghi trên shop thử. Lỗi gán theo vị trí trong `detail` khi khớp số SKU (probe-104b R6), không
   * thì cả lô; hai API cùng cách báo lỗi ("please check the detail field in the API response").
   */
  async function priceQuantityBatch(accessToken: string, batch: PriceQuantity[], kind: 'price' | 'stock'): Promise<PerSkuResult[]> {
    const skus = batch
      .map(
        (i) =>
          `<Sku><ItemId>${xml(i.externalProductId)}</ItemId><SkuId>${xml(i.externalSkuId)}</SkuId>` +
          (kind === 'price' ? `<Price>${xml(i.price!)}</Price>` : `<SellableQuantity>${i.quantity}</SellableQuantity>`) +
          '</Sku>',
      )
      .join('');
    const payload = `<Request><Product><Skus>${skus}</Skus></Product></Request>`;
    const path = kind === 'price' ? '/product/price_quantity/update' : '/product/stock/sellable/update';
    let body: LazadaResponse;
    try {
      body = await request(config.apiUrl, path, { access_token: accessToken, payload }, 'FORM');
    } catch (err) {
      if (!(err instanceof MarketplaceError)) throw err;
      const code = err.platformCode ?? 'marketplace_unavailable';
      const message = err.platformMessage ?? 'Sàn lỗi tạm';
      return batch.map((i) => ({ externalSkuId: i.externalSkuId, ok: false, code, message }));
    }
    if (body.code === '0') return batch.map((i) => ({ externalSkuId: i.externalSkuId, ok: true }));
    const err = lazadaError(body);
    if (err.kind === 'unauthorized') throw err;
    const detail = Array.isArray(body.detail) ? (body.detail as { code?: unknown; message?: unknown }[]) : [];
    const aligned = detail.length === batch.length;
    return batch.map((i, idx): PerSkuResult => {
      const d = aligned ? detail[idx] : undefined;
      if (aligned && !d?.code && !d?.message) return { externalSkuId: i.externalSkuId, ok: true };
      const code = String(d?.code ?? body.code);
      return {
        externalSkuId: i.externalSkuId,
        ok: false,
        code: LAZADA_PROMOTION_CODES.has(code) ? PROMOTION_LOCKED : code,
        message: String(d?.message ?? body.message ?? ''),
      };
    });
  }

  async function getSeller(accessToken: string): Promise<SellerInfo> {
    const body = await call(config.apiUrl, '/seller/get', { access_token: accessToken }, 'GET');
    const data = body.data as { seller_id?: unknown; name?: unknown } | undefined;
    if (data?.seller_id === undefined || typeof data.name !== 'string') {
      throw new MarketplaceError('rejected', 'unexpected_response');
    }
    // App gọi api.lazada.vn (chỉ VN).
    return { externalShopId: String(data.seller_id), shopName: data.name, region: 'VN' };
  }

  // Một token Lazada là một seller.
  async function connection(tokens: TokenSet): Promise<ShopConnection[]> {
    return [{ ...(await getSeller(tokens.accessToken)), tokens }];
  }

  const refresh = async (refreshToken: string) =>
    tokenSet(await call(`${config.authUrl}/rest`, '/auth/token/refresh', { refresh_token: refreshToken }, 'POST'));

  function tokenSet(body: LazadaResponse): TokenSet {
    if (typeof body.access_token !== 'string') throw new MarketplaceError('rejected', 'no_access_token');
    return {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
      accessExpiresAt: toDate(body.expires_in),
      refreshExpiresAt: toDate(body.refresh_expires_in),
    };
  }

  /** Một trang của `/orders/get` theo cửa sổ `update_after` (#218); `status` lọc trạng thái đơn (#198). */
  async function orderPage(accessToken: string, state: OrderCursor, status: string | null) {
    const params = {
      access_token: accessToken,
      update_after: vnTime(new Date(state.after * 1000)),
      sort_by: 'updated_at',
      sort_direction: 'ASC',
      limit: String(ORDER_PAGE),
      offset: String(state.offset),
      ...(status && { status }),
    };
    const body = await call(config.apiUrl, '/orders/get', params, 'GET');
    const data = (body.data ?? {}) as { countTotal?: unknown; orders?: Record<string, unknown>[] };
    const page = (data.orders ?? []).map((o) => ({
      externalOrderId: str(o.order_id),
      placedAt: lazadaTime(o.created_at),
      updatedAt: lazadaTime(o.updated_at),
      // Cả đơn của trang để `getOrders` không gọi lại `/order/get` (#267).
      detail: status ? { ...o, statuses: undefined } : o,
    }));
    const orders = page.filter((o) => state.seen[o.externalOrderId] !== epochSec(o.updatedAt));
    const safeUntil = state.lastId !== undefined && page[0]?.externalOrderId !== state.lastId ? new Date(state.after * 1000) : null;
    const last = page.at(-1);
    // Trang thiếu là hết; `countTotal` vẫn kiểm vì chưa rõ sàn có trả trang đủ 100 đúng lúc hết hay không.
    if (!last || page.length < ORDER_PAGE || state.offset + page.length >= Number(data.countTotal ?? 0)) {
      return { orders, next: null, safeUntil };
    }
    const seen = { ...state.seen };
    for (const o of page) seen[o.externalOrderId] = epochSec(o.updatedAt);
    const after = epochSec(last.updatedAt) - 1;
    const next: OrderCursor =
      after > state.after
        ? { after, offset: 0, seen: Object.fromEntries(Object.entries(seen).filter(([, t]) => t >= after)) }
        : { after: state.after, offset: state.offset + page.length - 1, seen, lastId: last.externalOrderId };
    return { orders, next, safeUntil };
  }

  /** SKU theo SellerSku trong một bộ lọc của GetProducts (`all` không gồm sản phẩm đã xoá, gọi thật 10/11/2026). */
  async function skusIn(accessToken: string, sellerSkus: readonly string[], filter: 'all' | 'deleted'): Promise<RemoteSku[]> {
    const wanted = new Set(sellerSkus);
    const out: RemoteSku[] = [];
    for (const batch of chunks(sellerSkus, SKU_LIST_BATCH)) {
      const params = {
        access_token: accessToken,
        filter,
        limit: String(SKU_LIST_BATCH),
        sku_seller_list: JSON.stringify(batch),
        // Kèm số bán được (`sellableStock`) cho đối chiếu tồn (#223).
        options: '1',
      };
      const body = await call(config.apiUrl, '/products/get', params, 'GET').catch((err: unknown) => {
        // E506 "Get product failed" (bảng mã của GetProducts): gọi thật 11/11/2026 gặp ngay sau /product/remove
        // (đọc lại vài giây sau thì `Deleted`). Lỗi tạm để đồng bộ thử lại lượt sau, không
        // coi là sàn từ chối. Chỉ đổi ở API đọc này: mã 506 ở API khác chưa rõ nghĩa.
        if (err instanceof MarketplaceError && err.kind === 'rejected' && err.platformCode === '506') {
          throw new MarketplaceError('unavailable', '506', err.platformMessage);
        }
        throw err;
      });
      const products = (body.data as { products?: LazadaProduct[] } | undefined)?.products ?? [];
      out.push(...products.flatMap(skusOf).filter((s) => wanted.has(s.sellerSku)));
    }
    return out;
  }

  // SellerSku không thấy ở `all` thì tra thêm `filter=deleted` (#219 A7): gọi thật 11/11/2026 trên shop thử, SellerSku
  // của sản phẩm đã xoá không có ở `all` (request_id 2101559517943940732651586), có ở `deleted` với `status: Deleted`
  // (21012d9d17943940737183996). Không thấy ở cả hai thì không trả.
  async function getSkus(accessToken: string, sellerSkus: readonly string[]): Promise<RemoteSku[]> {
    const found = await skusIn(accessToken, sellerSkus, 'all');
    const seen = new Set(found.map((s) => s.sellerSku));
    const missing = sellerSkus.filter((sku) => !seen.has(sku));
    return missing.length ? [...found, ...(await skusIn(accessToken, missing, 'deleted'))] : found;
  }

  /** SKU của `/product/create`, `/product/update`: tiền chuỗi, gam → kg, mm → cm. */
  const skuPayload = (p: NewProduct) => ({
    quantity: String(p.quantity),
    price: p.price,
    package_weight: String(p.weightG / 1000),
    package_length: String(p.lengthMm / 10),
    package_width: String(p.widthMm / 10),
    package_height: String(p.heightMm / 10),
  });

  /**
   * Thuộc tính giao hàng đang có của sản phẩm (`delivery_option_*`, GetProductItem): `/product/update` tự thêm
   * `delivery_option_standard`, `Delivery_Option_Instant` = "Yes" khi không gửi (Documents/tich-hop-san/lazada.md §11.4),
   * nên gửi kèm giá trị cũ để không đổi cách giao người bán đã chọn.
   */
  /** Một trang `/products/get` `filter=all`. `data` không phải object, `products` không phải mảng: `unexpected_response`. */
  async function productPage(accessToken: string, extra: Record<string, string>, offset: number) {
    const params = { access_token: accessToken, filter: 'all', limit: String(SKU_LIST_BATCH), offset: String(offset), ...extra };
    const body = await call(config.apiUrl, '/products/get', params, 'GET');
    if (typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)) throw new MarketplaceError('rejected', 'unexpected_response');
    const data = body.data as { products?: unknown; total_products?: unknown };
    if (data.products !== undefined && !Array.isArray(data.products)) throw new MarketplaceError('rejected', 'unexpected_response');
    const raw = data.total_products;
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
    return { products: (data.products ?? []) as LazadaProduct[], total: Number.isSafeInteger(n) && n >= 0 ? n : null };
  }

  /**
   * Sản phẩm sửa từ `since` (`update_after`), lật `offset`. Không kiểm tổng: tài liệu không nói `total_products` có theo
   * `update_after` không, và đọc thiếu ở đây chỉ làm chậm cập nhật bản sao, không xoá gì.
   */
  async function productsChanged(accessToken: string, since: Date): Promise<LazadaProduct[]> {
    const out = new Map<string, LazadaProduct>();
    for (let offset = 0; ; offset += SKU_LIST_BATCH) {
      if (offset > MAX_PRODUCT_OFFSET) {
        throw new MarketplaceError('rejected', 'too_many_products', `Gian hàng có hơn ${MAX_PRODUCT_OFFSET} sản phẩm sửa từ mốc, sàn không cho đọc hết`);
      }
      const { products } = await productPage(accessToken, { update_after: vnTime(since) }, offset);
      for (const p of products) out.set(String(p.item_id), p);
      if (products.length < SKU_LIST_BATCH) return [...out.values()];
    }
  }

  /**
   * Mọi sản phẩm `filter=all` cho lần đọc trọn (bản sao SKU sàn xoá SKU không thấy, nên không được trả thiếu).
   *
   * GetProducts (open.lazada.com, tra bằng trình duyệt 12/11/2026) không có tham số sắp xếp; về `offset` tài liệu ghi:
   * "Deprecated(The number of Items you want to skip before you start counting),It is recommended to use date for scrolling
   * query.The maximum offset is 10000", và `create_after` / `create_before`: "Limits the returned products to those
   * created after or on the specified date" / "created before or on the specified date, given in ISO 8601 date format".
   * Gọi thật 12/11/2026 (shop thử, đọc): `create_before` 2012-01-01 trả 0 sản phẩm, không có `total_products`; khoảng
   * 20:48:05–20:48:10 ngày 22/10/2026 trả `total_products` 4 đúng 4 sản phẩm; 01/10–20/10 trả 15 đúng 15: tổng có lọc theo
   * ngày tạo. Trang không xếp theo ngày tạo (trang đầu của cả gian hàng không chứa sản phẩm cũ nhất).
   * Lật `offset` mà sàn đổi thứ tự giữa chừng (sản phẩm vừa sửa) thì sót hoặc trùng (review #309 vòng 3 R1). Vì vậy chia
   * theo khoảng ngày tạo (không đổi theo thời gian): khoảng nào sàn báo quá 50 sản phẩm thì chia ở trung vị giờ tạo của trang vừa nhận, tới khi mỗi khoảng
   * vừa một trang `offset` 0, nên không phụ thuộc thứ tự. Hai nửa dùng chung giây ở giữa (hai đầu đều lấy cả mốc, mốc tính
   * theo giây còn giờ tạo có phần mili giây), sản phẩm trùng gộp theo `item_id`. Khoảng chỉ còn một giây mà vẫn quá 50
   * (nhập hàng loạt) thì lật `offset` trong khoảng đó. Khoảng nào trả ít hơn `total_products` của nó thì `incomplete_list`.
   * Gian hàng quá `MAX_PRODUCT_OFFSET` sản phẩm thì `too_many_products` như trước. Chốt chặn (vòng 4 B2): hai nửa cùng
   * báo đúng tổng khoảng cha thì coi là sàn không lọc, lật `offset` khoảng cha; mỗi lần đọc trọn tối đa
   * ⌈tổng / 50⌉ × 10 + 64 lời gọi, chạm trần thì `too_many_calls`.
   */
  async function productsAll(accessToken: string): Promise<LazadaProduct[]> {
    const out = new Map<string, LazadaProduct>();
    let calls = 0;
    let budget = MAX_WINDOW_CALLS;
    const page = async (from: number, to: number, offset: number) => {
      if (++calls > budget) {
        throw new MarketplaceError('rejected', 'too_many_calls', `Đọc danh sách sản phẩm quá ${budget} lời gọi, dừng để giữ hạn mức gọi sàn`);
      }
      return productPage(accessToken, { create_after: vnTime(new Date(from * 1000)), create_before: vnTime(new Date(to * 1000)) }, offset);
    };
    type Page = Awaited<ReturnType<typeof page>>;
    // Điểm chia theo dữ liệu (review #309 vòng 5 C1): trung vị giây tạo của trang vừa nhận, nên mỗi nửa ít hơn khoảng cha
    // và số lời gọi theo số sản phẩm chứ không theo số đợt đăng hàng loạt. Kẹp trong (from, to) để khoảng luôn hẹp lại.
    // Trang không có `created_time` đọc được thì lấy giữa khoảng.
    const splitPoint = (from: number, to: number, products: readonly LazadaProduct[]) => {
      const secs = products
        .map((p) => Math.floor(Number(p.created_time) / 1000))
        .filter(Number.isSafeInteger)
        .sort((a, b) => a - b);
      const mid = secs.length ? secs[Math.floor((secs.length - 1) / 2)]! : Math.floor((from + to) / 2);
      return Math.min(to - 1, Math.max(from + 1, mid));
    };
    const countOf = (p: Page) => p.total ?? (p.products.length < SKU_LIST_BATCH ? p.products.length : null);
    // Lật `offset` trong khoảng (dự phòng): khoảng một giây quá 50 sản phẩm, hoặc sàn không lọc tổng theo ngày tạo.
    const byOffset = async (from: number, to: number, first: Page, count: number | null) => {
      const seen = new Map(first.products.map((p) => [String(p.item_id), p]));
      for (let offset = SKU_LIST_BATCH; first.products.length >= SKU_LIST_BATCH; offset += SKU_LIST_BATCH) {
        const { products } = await page(from, to, offset);
        for (const p of products) seen.set(String(p.item_id), p);
        if (products.length < SKU_LIST_BATCH) break;
      }
      if (count !== null && seen.size < count) throw incomplete(count, seen.size);
      for (const [id, p] of seen) out.set(id, p);
    };
    const walk = async (from: number, to: number, first: Page): Promise<void> => {
      const count = countOf(first);
      if (count !== null && count <= SKU_LIST_BATCH) {
        if (new Set(first.products.map((p) => String(p.item_id))).size < count) throw incomplete(count, first.products.length);
        for (const p of first.products) out.set(String(p.item_id), p);
        return;
      }
      if (to - from < 2) return byOffset(from, to, first, count);
      const mid = splitPoint(from, to, first.products);
      const left = await page(from, mid, 0);
      const right = await page(mid, to, 0);
      // Hai nửa đều báo đúng tổng của khoảng cha: sàn không lọc `total_products` theo ngày tạo (gọi thật 12/11/2026 thì có
      // lọc, đây là chốt chặn nếu sàn đổi). Thôi chia, lật `offset` khoảng cha một lần (review #309 vòng 4 B2).
      if (count !== null && countOf(left) === count && countOf(right) === count) return byOffset(from, to, first, count);
      await walk(from, mid, left);
      await walk(mid, to, right);
    };
    const from = Math.floor(LAZADA_EPOCH_MS / 1000);
    const to = Math.ceil(Date.now() / 1000);
    const first = await page(from, to, 0);
    const total = countOf(first);
    if ((total ?? 0) > MAX_PRODUCT_OFFSET) {
      throw new MarketplaceError('rejected', 'too_many_products', `Gian hàng có hơn ${MAX_PRODUCT_OFFSET} sản phẩm, sàn không cho đọc hết`);
    }
    // Trần cứng theo số sản phẩm. Trung vị lấy từ trang vừa nhận, không phải từ cả khoảng: sàn trả theo giờ tạo tăng hoặc
    // giảm (tài liệu không nói thứ tự, gọi thật chỉ thấy trang đầu không xếp tăng) thì trang là 50 sản phẩm ở một đầu,
    // trung vị lệch về đầu đó và mỗi lần chia chỉ bớt được khoảng nửa trang. Mô phỏng (review #309 vòng 6): đăng theo đợt,
    // rải đều tốn tối đa 4,16 lời gọi mỗi trang 50 sản phẩm, nhưng đăng một lần 10 000 sản phẩm 14 sản phẩm mỗi giây tốn
    // 1 423 (7,1 mỗi trang). Lấy 10, cộng 64 cho khoảng không có `created_time` phải chia giữa (2012 tới nay chia đôi tới
    // một giây cần 29 lần, mỗi lần 2 lời gọi); kẹp `MAX_WINDOW_CALLS`.
    if (total !== null) budget = Math.min(MAX_WINDOW_CALLS, Math.ceil(total / SKU_LIST_BATCH) * 10 + 64);
    await walk(from, to, first);
    return [...out.values()];
  }

  async function deliveryOptions(accessToken: string, itemId: string): Promise<Record<string, string>> {
    const body = await call(config.apiUrl, '/product/item/get', { access_token: accessToken, item_id: itemId }, 'GET');
    const attrs = ((body.data as { attributes?: Record<string, unknown> } | undefined)?.attributes ?? {}) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(attrs).flatMap(([k, v]) => (/^delivery_option_/i.test(k) && typeof v === 'string' ? [[k, v]] : [])),
    );
  }

  return {
    // Yêu cầu trả (#202), file riêng `lazada-returns.ts`.
    ...lazadaReturnMethods((apiPath, params) => call(config.apiUrl, apiPath, params, 'GET')),
    name: 'Lazada',
    capabilities: LAZADA_CAPABILITIES,
    connectMethods() {
      // Chỉ OAuth cần trang callback; nối bằng token không cần.
      return oauthReady ? ['oauth', 'token'] : hasCredentials ? ['token'] : [];
    },
    authorizeUrl(state) {
      if (!oauthReady) throw new MarketplaceError('unsupported');
      const { appKey } = credentials();
      const query = new URLSearchParams({
        response_type: 'code',
        force_auth: 'true',
        redirect_uri: config.redirectUrl!,
        client_id: appKey,
        state,
      });
      return `${config.authUrl}/oauth/authorize?${query}`;
    },
    async exchangeCode(params) {
      const code = params.code;
      if (!code) throw new MarketplaceError('rejected', 'missing_parameter', 'Thiếu code trên URL callback');
      return connection(tokenSet(await call(`${config.authUrl}/rest`, '/auth/token/create', { code }, 'POST')));
    },
    async connectWithToken({ accessToken, refreshToken }) {
      // Có refresh token thì làm mới một lần để biết hạn; không có thì hạn để trống, hết hạn thì dán token mới.
      const tokens: TokenSet = refreshToken
        ? await refresh(refreshToken)
        : { accessToken, refreshToken: null, accessExpiresAt: null, refreshExpiresAt: null };
      return connection(tokens);
    },
    refreshToken: refresh,
    // Access Lazada sống 7 ngày, refresh 50 ngày và không gia hạn (21 §18.4). Ngưỡng 48 giờ giữ từ #102, chưa đo trên shop
    // thử (app Testing có access ngắn hơn, Documents#64): với việc nền mỗi giờ là còn khoảng 48 lượt thử trước khi hết hạn.
    refreshDueAt: (tokens) => refreshBefore(tokens, DEFAULT_REFRESH_LEAD_MS),
    // "refresh_expires_in: The remaining seconds until the current refresh token expires. For example, 4320000 seconds
    // equates to 50 days. After 50 days, the refresh token will expire, and a new refresh token can only be obtained by
    // completing the authorization process again. Note: The refresh token cannot be refreshed using the
    // RefreshAccessToken API." (open.lazada.com, Seller authorization introduction, mục 5, cập nhật 05/03/2026, đọc
    // 12/11/2026). Hạn cố định theo lần uỷ quyền: làm mới giữ hạn đã lưu (#312).
    refreshKeepsAuthDeadline: true,
    async listCategories(accessToken): Promise<PlatformCategory[]> {
      const params = { access_token: accessToken, language_code: 'vi_VN' };
      const body = await call(config.apiUrl, '/category/tree/get', params, 'GET');
      type Node = { category_id?: unknown; name?: unknown; leaf?: unknown; children?: Node[] };
      const leaves: PlatformCategory[] = [];
      const walk = (n: Node, trail: string[]) => {
        const path = [...trail, String(n.name ?? '')];
        if (n.leaf) leaves.push({ externalId: String(n.category_id), name: path.join(' > ') });
        else for (const c of n.children ?? []) walk(c, path);
      };
      for (const n of (body.data as Node[] | undefined) ?? []) walk(n, []);
      return leaves;
    },
    async categoryAttributes(accessToken, externalCategoryId): Promise<CategoryAttribute[]> {
      const params = { access_token: accessToken, primary_category_id: externalCategoryId, language_code: 'vi_VN' };
      const body = await call(config.apiUrl, '/category/attributes/get', params, 'GET');
      type Attr = {
        name?: unknown;
        label?: unknown;
        is_mandatory?: unknown;
        attribute_type?: unknown;
        options?: { name?: unknown }[];
      };
      // `name`, `description` và thuộc tính cấp SKU (giá, kích thước gói) BE tự điền từ catalog.
      return ((body.data as Attr[] | undefined) ?? [])
        .filter((a) => String(a.is_mandatory) === '1' && a.attribute_type === 'normal')
        .filter((a) => a.name !== 'name' && a.name !== 'description')
        .map((a) => ({
          name: String(a.name),
          label: String(a.label ?? a.name),
          options: (a.options ?? []).map((o) => String(o.name)),
        }));
    },
    async uploadImage(accessToken, url) {
      const payload = `<?xml version="1.0" encoding="UTF-8" ?><Request><Image><Url>${xml(url)}</Url></Image></Request>`;
      const body = await call(config.apiUrl, '/image/migrate', { access_token: accessToken, payload }, 'FORM');
      const image = (body.data as { image?: { url?: unknown } } | undefined)?.image;
      if (typeof image?.url !== 'string') throw new MarketplaceError('rejected', 'unexpected_response');
      return image.url;
    },
    async createProduct(accessToken, p: NewProduct) {
      // Idempotent theo SellerSku: lần đẩy trước đã tạo mà bên gọi mất kết quả thì trả sản phẩm đó, không tạo thêm.
      const existing = (await skusIn(accessToken, [p.sellerSku], 'all')).find((s) => s.state !== 'deleted');
      if (existing) return { externalProductId: existing.externalProductId, externalSkuId: existing.externalSkuId, live: existing.state === 'live' };
      const payload = JSON.stringify({
        Request: {
          Product: {
            PrimaryCategory: p.externalCategoryId,
            Images: { Image: p.imageUrls },
            Attributes: { ...p.attributes, name: p.name, description: p.description },
            Skus: { Sku: [{ SellerSku: p.sellerSku, ...skuPayload(p) }] },
          },
        },
      });
      const body = await call(config.apiUrl, '/product/create', { access_token: accessToken, payload }, 'FORM');
      const data = body.data as { item_id?: unknown; item_status?: unknown; sku_list?: { sku_id?: unknown }[] } | undefined;
      const skuId = data?.sku_list?.[0]?.sku_id;
      if (data?.item_id === undefined || skuId === undefined) throw new MarketplaceError('rejected', 'unexpected_response');
      return { externalProductId: String(data.item_id), externalSkuId: String(skuId), live: data.item_status === 'Active' };
    },
    // UpdateProduct (open.lazada.com "Update a product", tra 11/11/2026): payload như `/product/create`, `SkuId` bắt buộc
    // (mã 4216), không đổi được SellerSku; `Status: active` bật lại SKU đã tắt (lazada.md §11.4). Trạng thái sau khi ghi
    // đọc lại bằng GetProducts theo SellerSku; chưa thấy (sàn trễ) thì coi là chờ duyệt, đồng bộ sửa sau.
    async updateProduct(accessToken, externalProductId, externalSkuId, p: NewProduct) {
      const payload = JSON.stringify({
        Request: {
          Product: {
            ItemId: externalProductId,
            PrimaryCategory: p.externalCategoryId,
            Images: { Image: p.imageUrls },
            Attributes: { ...p.attributes, ...(await deliveryOptions(accessToken, externalProductId)), name: p.name, description: p.description },
            Skus: { Sku: [{ SkuId: externalSkuId, ...skuPayload(p), Status: 'active' }] },
          },
        },
      });
      await call(config.apiUrl, '/product/update', { access_token: accessToken, payload }, 'FORM');
      const after = (await skusIn(accessToken, [p.sellerSku], 'all')).find((s) => s.externalSkuId === externalSkuId);
      if (!after || after.state === 'review' || after.state === 'rejected') return { live: false };
      if (after.state === 'live') return { live: true };
      throw new MarketplaceError('rejected', 'still_inactive', `Sàn chưa bật lại sản phẩm (trạng thái ${after.state})`);
    },
    getSkus,
    // Số sản phẩm: một lời gọi `limit=1`, đọc `total_products` (#198/#284: đọc từng trang quá hạn 10 giây với gian hàng
    // vài trăm sản phẩm). Tài liệu GetProducts chỉ có `total_products` ở response mẫu (chuỗi). Gọi thật 10/11/2026 trên
    // shop thử: số, đổi theo `filter`, và `all` (305) = live 7 + inactive 236 + rejected 59 + sold-out 3, không gồm
    // deleted (96), nên `filter=all` đã bỏ sản phẩm đã xoá. Không có sản phẩm nào thì sàn bỏ hẳn trường (gọi thật
    // `filter=pending`): coi là 0. Lazada không trả tổng số SKU (SKU chỉ có trong `products[].skus[]`, phải đọc hết các
    // trang), nên `skuCount` luôn null ở đây. Phản hồi thành công mà `data` vắng hoặc không phải object thì `rejected`
    // `unexpected_response`, không coi là 0 (§18.7.4: không trả 0 thay cho lỗi); `data` có mà thiếu `total_products` và
    // không có sản phẩm nào mới là 0.
    async countRemote(accessToken): Promise<RemoteCounts> {
      const body = await call(config.apiUrl, '/products/get', { access_token: accessToken, filter: 'all', limit: '1', offset: '0' }, 'GET');
      if (typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)) throw new MarketplaceError('rejected', 'unexpected_response');
      const data = body.data as { total_products?: unknown; products?: unknown };
      const raw = data.total_products;
      if (raw === undefined || raw === null) {
        if (!Array.isArray(data.products) || data.products.length === 0) return { productCount: 0, skuCount: null };
        throw new MarketplaceError('rejected', 'unexpected_response');
      }
      const total = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
      if (!Number.isSafeInteger(total) || total < 0) throw new MarketplaceError('rejected', 'unexpected_response');
      return { productCount: total, skuCount: null };
    },
    // Lật `offset` (sàn không nói thứ tự khi lọc theo ngày nên không lật theo ngày được); bỏ sản phẩm đã xoá (#198).
    async listSkus(accessToken): Promise<RemoteSku[]> {
      return (await productsAll(accessToken)).flatMap(skusOf).filter((s) => s.state !== 'deleted');
    },
    // GetProducts (open.lazada.com, tra 12/11/2026): "update_after String No Limits the returned products to those updated
    // after or on the specified date, given in ISO 8601 date format." Chỉ `filter=all` (không gồm sản phẩm đã xoá, gọi thật
    // 10/11/2026): không gọi thêm `filter=deleted` để giữ hạn mức gọi chung của app (review #309 vòng 2 N2); SKU đã xoá
    // trên sàn rời bản sao ở lần đọc trọn mỗi ngày hoặc khi bấm Tải lại.
    async listSkusChanged(accessToken, since): Promise<RemoteSku[]> {
      return (await productsChanged(accessToken, since)).flatMap(skusOf);
    },
    // Tồn trước, giá sau, mỗi loại theo lô 20; SKU có cả hai thì lỗi ở một trong hai là lỗi của SKU (giữ lỗi đầu tiên).
    async updatePriceQuantity(accessToken, items) {
      // Tồn và giá là hai API riêng: kết quả trả riêng từng phần (#223), tồn bị khoá (4170) không làm giá thành lỗi.
      const errors = { stock: new Map<string, { code: string; message: string }>(), price: new Map<string, { code: string; message: string }>() };
      for (const kind of ['stock', 'price'] as const) {
        const subset = items.filter((i) => (kind === 'stock' ? i.quantity !== undefined : i.price !== undefined));
        for (const batch of chunks(subset, PRICE_QTY_BATCH)) {
          for (const r of await priceQuantityBatch(accessToken, batch, kind)) {
            if (!r.ok && !errors[kind].has(r.externalSkuId)) errors[kind].set(r.externalSkuId, { code: r.code, message: r.message });
          }
        }
      }
      return partResults(items, errors.stock, errors.price);
    },
    async deactivate(accessToken, externalProductId, externalSkuId) {
      const apiRequestBody =
        `<Request><Product><ItemId>${xml(externalProductId)}</ItemId>` +
        `<Skus><SkuId>${xml(externalSkuId)}</SkuId></Skus></Product></Request>`;
      await call(config.apiUrl, '/product/deactivate', { access_token: accessToken, apiRequestBody }, 'FORM');
    },
    // Lật theo cửa sổ `update_after` tăng dần, không theo offset (#218): đơn đổi giữa chừng có `updated_at` mới nên nằm
    // sau con trỏ. Trang sau gọi từ giây của đơn cuối trang trừ 1 (tài liệu không nói `update_after` có lấy cả mốc) và
    // bỏ đơn đã trả theo `order_id`. Cả trang trong một giây thì mốc không tiến: giữ mốc, lật `offset` gối một đơn.
    // Trang lật offset không mở đầu bằng đơn cuối trang trước là danh sách đã xê dịch (đơn trong nhóm đổi, hoặc sàn
    // xếp các đơn cùng giây khác đi): có thể sót đơn từ mốc, báo `safeUntil` để bên gọi không tiến mốc qua đó.
    async listOrders(accessToken, updatedAfter, cursor) {
      const state: OrderCursor = cursor ? (JSON.parse(cursor) as OrderCursor) : { after: epochSec(updatedAfter), offset: 0, seen: {} };
      const page = await orderPage(accessToken, state, null);
      return { orders: page.orders, nextCursor: page.next && JSON.stringify(page.next), safeUntil: page.safeUntil };
    },
    // Mỗi trạng thái mở lật bằng đúng cửa sổ `update_after` của `listOrders`, hết trạng thái thì sang trạng thái sau.
    async listOpenOrders(accessToken, cursor) {
      const fresh = (status: number): OpenOrderCursor => ({ status, inner: { after: OPEN_ORDERS_FROM, offset: 0, seen: {} } });
      const state: OpenOrderCursor = cursor ? (JSON.parse(cursor) as OpenOrderCursor) : fresh(0);
      const page = await orderPage(accessToken, state.inner, OPEN_STATUSES[state.status]!);
      const next = page.next ? { status: state.status, inner: page.next } : state.status + 1 < OPEN_STATUSES.length ? fresh(state.status + 1) : null;
      return { orders: page.orders, nextCursor: next && JSON.stringify(next), safeUntil: page.safeUntil };
    },
    async getOrder(accessToken, externalOrderId): Promise<RemoteOrder> {
      const params = { access_token: accessToken, order_id: externalOrderId };
      const o = ((await call(config.apiUrl, '/order/get', params, 'GET')).data ?? {}) as Row;
      const items = ((await call(config.apiUrl, '/order/items/get', params, 'GET')).data ?? []) as Row[];
      return toRemoteOrder(o, items);
    },
    // Theo lô (#267): thông tin đơn lấy từ trang `/orders/get` đã đọc (`detail`), món lấy bằng `/orders/items/get` tối đa
    // 50 đơn mỗi lần (tài liệu GetMultipleOrderItems). Ref không có `detail` thì gọi `/order/get`; đơn sàn không trả món
    // trong lô thì gọi `/order/items/get` riêng đơn đó.
    async getOrders(accessToken, refs): Promise<RemoteOrder[]> {
      const orders: Row[] = [];
      for (const ref of refs) {
        const params = { access_token: accessToken, order_id: ref.externalOrderId };
        orders.push((ref.detail as Row | undefined) ?? (((await call(config.apiUrl, '/order/get', params, 'GET')).data ?? {}) as Row));
      }
      const items = new Map<string, Row[]>();
      for (const batch of chunks(refs.map((r) => r.externalOrderId), ORDER_ITEMS_BATCH)) {
        const params = { access_token: accessToken, order_ids: `[${batch.join(',')}]` };
        const data = ((await call(config.apiUrl, '/orders/items/get', params, 'GET')).data ?? []) as Row[];
        for (const d of data) items.set(str(d.order_id), (d.order_items ?? []) as Row[]);
      }
      const out: RemoteOrder[] = [];
      for (const [i, ref] of refs.entries()) {
        const own =
          items.get(ref.externalOrderId) ??
          ((await call(config.apiUrl, '/order/items/get', { access_token: accessToken, order_id: ref.externalOrderId }, 'GET')).data ?? []) as Row[];
        out.push(toRemoteOrder(orders[i]!, own));
      }
      return out;
    },
    // Hành trình kiện (spec #199 phần c §5.7): chỉ lấy mốc, lý do; trạng thái kiện vẫn theo trạng thái món.
    async getPackageEvents(accessToken, externalOrderId) {
      const body = await call(config.apiUrl, '/logistic/order/trace', { access_token: accessToken, order_id: externalOrderId }, 'GET');
      return lazadaPackageEvents(body.result);
    },
    // Huỷ đơn (#105 PR 2, tài liệu Return and Refund API đọc 29/10/2026).
    async cancelReasons(accessToken, externalOrderId, externalLineIds) {
      const params = { access_token: accessToken, order_id: externalOrderId, order_item_id_list: JSON.stringify(externalLineIds) };
      const data = ((await call(config.apiUrl, '/order/reverse/cancel/validate', params, 'GET')).data ?? {}) as Record<string, unknown>;
      const options = (data.reason_options as { reason_id?: unknown; reason_name?: unknown }[] | undefined) ?? [];
      if (!options.length) throw new MarketplaceError('rejected', 'not_cancellable', str(data.tip_content) || null);
      return options.map((o) => ({ id: str(o.reason_id), label: str(o.reason_name) }));
    },
    async cancelOrder(accessToken, externalOrderId, externalLineIds, reasonId) {
      const params = {
        access_token: accessToken,
        order_id: externalOrderId,
        order_item_id_list: JSON.stringify(externalLineIds),
        reason_id: reasonId,
      };
      const data = ((await call(config.apiUrl, '/order/reverse/cancel/create', params, 'GET')).data ?? {}) as Record<string, unknown>;
      if (data.tip_type === 'error') throw new MarketplaceError('rejected', 'cancel_refused', str(data.tip_content) || null);
    },
    async decideCancelRequest(accessToken, externalOrderId, accept) {
      // Quyết định gửi theo mã đơn ngược của yêu cầu huỷ, nên tra đơn ngược loại CANCEL của đơn trước.
      const query = {
        access_token: accessToken,
        trade_order_id: externalOrderId,
        request_type_list: JSON.stringify(['CANCEL']),
        page_no: '1',
        page_size: '10',
      };
      const body = await call(config.apiUrl, '/reverse/getreverseordersforseller', query, 'GET');
      const items = ((body.result as { items?: Record<string, unknown>[] } | undefined)?.items ?? []).filter((i) => i.request_type === 'CANCEL');
      const reverseId = str(items[0]?.reverse_order_id);
      if (!reverseId) throw new MarketplaceError('rejected', 'cancel_request_not_found', 'Sàn không còn yêu cầu huỷ của đơn này');
      await call(
        config.apiUrl,
        '/order/reverse/cancel/seller/decide',
        { access_token: accessToken, reverse_order_id: reverseId, agree_cancel: String(accept) },
        'GET',
      );
    },
    // Tài chính (#117, lazada.md §7.6). Tên trường theo tài liệu và sàn giả lập #115, chưa đối chiếu response thật.
    async getTransactions(accessToken, from, to): Promise<SettlementTxn[]> {
      const out: SettlementTxn[] = [];
      for (let offset = 0; ; offset += TXN_PAGE) {
        const params = { access_token: accessToken, start_time: from, end_time: to, limit: String(TXN_PAGE), offset: String(offset) };
        const body = await call(config.apiUrl, '/finance/transaction/details/get', params, 'GET');
        const rows = (body.data as Row[] | undefined) ?? [];
        for (const r of rows) {
          out.push({
            txnId: normalizeLazadaTxnId(r.transaction_number),
            externalOrderId: r.order_no ? String(r.order_no) : null,
            date: String(r.transaction_date ?? '').slice(0, 10),
            feeName: String(r.fee_name ?? ''),
            feeCode: r.fee_type === undefined || r.fee_type === null || r.fee_type === '' ? null : String(r.fee_type),
            transactionType: String(r.transaction_type ?? ''),
            amount: String(r.amount ?? '0'),
            withholding: String(r.WHT_amount ?? '0'),
            kind: lazadaLedgerKind(String(r.fee_name ?? ''), String(r.transaction_type ?? '')),
          });
        }
        if (rows.length < TXN_PAGE) return out.filter((t) => t.txnId);
      }
    },
    async getPayouts(accessToken, from): Promise<Payout[]> {
      const body = await call(config.apiUrl, '/finance/payout/status/get', { access_token: accessToken, created_after: from }, 'GET');
      return ((body.data as Record<string, unknown>[] | undefined) ?? []).map((p) => ({
        statementNumber: String(p.statement_number ?? ''),
        createdAt: String(p.created_at ?? ''),
        payout: String(p.payout ?? '0'),
        closingBalance: String(p.closing_balance ?? '0'),
        paid: String(p.paid ?? '0') === '1' || p.paid === true,
      }));
    },
  };
}
