// Adapter Lazada Open Platform (Documents/tich-hop-san/lazada.md §2, §3, §7.1). Cách ký chép từ scripts/smoke/lazada.ts.
import { createHmac } from 'node:crypto';
import {
  type CategoryAttribute,
  type MarketplaceAdapter,
  MarketplaceError,
  type NewProduct,
  type Payout,
  type PerSkuResult,
  type PlatformCategory,
  type PriceQuantity,
  type RemoteLineStatus,
  type RemoteOrder,
  type RemoteSku,
  type RemoteState,
  type SellerInfo,
  type SettlementTxn,
  type TokenSet,
} from './common.ts';

export interface LazadaConfig {
  appKey: string | undefined;
  appSecret: string | undefined;
  redirectUrl: string | undefined;
  apiUrl: string;
  authUrl: string;
}

type LazadaResponse = Record<string, unknown> & { code?: string; message?: string; type?: string };

const TIMEOUT_MS = 10_000;
// Mã token sai hoặc hết hạn (lazada.md §6): gian hàng cần nối lại, không thử lại.
const AUTH_CODES = new Set(['IllegalAccessToken', 'IllegalRefreshToken', 'InvalidCode', 'InvalidRefreshToken']);
// Mã số là lỗi nghiệp vụ dù mang type ISP (probe-104b), trừ mã lỗi tạm: nội bộ, gọi quá nhanh (tài liệu CreateProduct).
const TRANSIENT_NUMERIC = new Set(['6', '901', '1000', '4154']);
// UpdatePriceQuantity: tối đa 50 SKU một lần, Lazada khuyên 20.
const PRICE_QTY_BATCH = 20;
// GetProducts: `limit` tối đa 50; một sản phẩm một SKU (#104 A1).
const SKU_LIST_BATCH = 50;
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
  skus?: { SkuId?: unknown; SellerSku?: unknown; quantity?: unknown }[];
};

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

const SELLER_LIMIT_WAIT_MS = 1100;
// GetOrders: `limit` tối đa 100.
const ORDER_PAGE = 100;

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

const toDate = (seconds: unknown) => (Number(seconds) > 0 ? new Date(Date.now() + Number(seconds) * 1000) : null);

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

  /** Một lô UpdatePriceQuantity: lỗi gán theo vị trí trong `detail` khi khớp số SKU (probe-104b R6), không thì cả lô. */
  async function priceQuantityBatch(accessToken: string, batch: PriceQuantity[]): Promise<PerSkuResult[]> {
    const skus = batch
      .map(
        (i) =>
          `<Sku><ItemId>${xml(i.externalProductId)}</ItemId><SkuId>${xml(i.externalSkuId)}</SkuId>` +
          (i.price === undefined ? '' : `<Price>${xml(i.price)}</Price>`) +
          (i.quantity === undefined ? '' : `<Quantity>${i.quantity}</Quantity>`) +
          '</Sku>',
      )
      .join('');
    const payload = `<Request><Product><Skus>${skus}</Skus></Product></Request>`;
    let body: LazadaResponse;
    try {
      body = await request(config.apiUrl, '/product/price_quantity/update', { access_token: accessToken, payload }, 'FORM');
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
      return {
        externalSkuId: i.externalSkuId,
        ok: false,
        code: String(d?.code ?? body.code),
        message: String(d?.message ?? body.message ?? ''),
      };
    });
  }

  function tokenSet(body: LazadaResponse): TokenSet {
    if (typeof body.access_token !== 'string') throw new MarketplaceError('rejected', 'no_access_token');
    return {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
      accessExpiresAt: toDate(body.expires_in),
      refreshExpiresAt: toDate(body.refresh_expires_in),
    };
  }

  return {
    name: 'Lazada',
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
    async exchangeCode(code) {
      return tokenSet(await call(`${config.authUrl}/rest`, '/auth/token/create', { code }, 'POST'));
    },
    async refreshToken(refreshToken) {
      return tokenSet(await call(`${config.authUrl}/rest`, '/auth/token/refresh', { refresh_token: refreshToken }, 'POST'));
    },
    async getSeller(accessToken): Promise<SellerInfo> {
      const body = await call(config.apiUrl, '/seller/get', { access_token: accessToken }, 'GET');
      const data = body.data as { seller_id?: unknown; name?: unknown } | undefined;
      if (data?.seller_id === undefined || typeof data.name !== 'string') {
        throw new MarketplaceError('rejected', 'unexpected_response');
      }
      return { externalShopId: String(data.seller_id), shopName: data.name, region: 'VN' };
    },
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
      const sku = {
        SellerSku: p.sellerSku,
        quantity: String(p.quantity),
        price: p.price,
        package_weight: String(p.weightG / 1000),
        package_length: String(p.lengthMm / 10),
        package_width: String(p.widthMm / 10),
        package_height: String(p.heightMm / 10),
      };
      const payload = JSON.stringify({
        Request: {
          Product: {
            PrimaryCategory: p.externalCategoryId,
            Images: { Image: p.imageUrls },
            Attributes: { ...p.attributes, name: p.name, description: p.description },
            Skus: { Sku: [sku] },
          },
        },
      });
      const body = await call(config.apiUrl, '/product/create', { access_token: accessToken, payload }, 'FORM');
      const data = body.data as { item_id?: unknown; item_status?: unknown; sku_list?: { sku_id?: unknown }[] } | undefined;
      const skuId = data?.sku_list?.[0]?.sku_id;
      if (data?.item_id === undefined || skuId === undefined) throw new MarketplaceError('rejected', 'unexpected_response');
      return { externalProductId: String(data.item_id), externalSkuId: String(skuId), live: data.item_status === 'Active' };
    },
    async getSkus(accessToken, sellerSkus): Promise<RemoteSku[]> {
      const wanted = new Set(sellerSkus);
      const out: RemoteSku[] = [];
      for (const batch of chunks(sellerSkus, SKU_LIST_BATCH)) {
        const params = {
          access_token: accessToken,
          filter: 'all',
          limit: String(SKU_LIST_BATCH),
          sku_seller_list: JSON.stringify(batch),
        };
        const body = await call(config.apiUrl, '/products/get', params, 'GET');
        for (const p of (body.data as { products?: LazadaProduct[] } | undefined)?.products ?? []) {
          const { state, rejectReason } = remoteState(p);
          for (const s of p.skus ?? []) {
            const sellerSku = String(s.SellerSku ?? '');
            if (!wanted.has(sellerSku)) continue;
            out.push({
              externalProductId: String(p.item_id),
              externalSkuId: String(s.SkuId),
              sellerSku,
              title: String(p.attributes?.name ?? ''),
              state,
              rejectReason,
              quantity: Number(s.quantity ?? 0),
            });
          }
        }
      }
      return out;
    },
    async updatePriceQuantity(accessToken, items) {
      const results: PerSkuResult[] = [];
      for (const batch of chunks(items, PRICE_QTY_BATCH)) results.push(...(await priceQuantityBatch(accessToken, batch)));
      return results;
    },
    async deactivate(accessToken, externalProductId, externalSkuId) {
      const apiRequestBody =
        `<Request><Product><ItemId>${xml(externalProductId)}</ItemId>` +
        `<Skus><SkuId>${xml(externalSkuId)}</SkuId></Skus></Product></Request>`;
      await call(config.apiUrl, '/product/deactivate', { access_token: accessToken, apiRequestBody }, 'FORM');
    },
    async listOrders(accessToken, updatedAfter, offset) {
      const params = {
        access_token: accessToken,
        update_after: vnTime(updatedAfter),
        sort_by: 'updated_at',
        sort_direction: 'ASC',
        limit: String(ORDER_PAGE),
        offset: String(offset),
      };
      const body = await call(config.apiUrl, '/orders/get', params, 'GET');
      const data = (body.data ?? {}) as { countTotal?: unknown; orders?: Record<string, unknown>[] };
      const orders = (data.orders ?? []).map((o) => ({
        externalOrderId: str(o.order_id),
        placedAt: lazadaTime(o.created_at),
        updatedAt: lazadaTime(o.updated_at),
      }));
      return { orders, hasMore: offset + orders.length < Number(data.countTotal ?? 0) };
    },
    async getOrder(accessToken, externalOrderId): Promise<RemoteOrder> {
      type Row = Record<string, unknown>;
      const params = { access_token: accessToken, order_id: externalOrderId };
      const o = ((await call(config.apiUrl, '/order/get', params, 'GET')).data ?? {}) as Row;
      const items = ((await call(config.apiUrl, '/order/items/get', params, 'GET')).data ?? []) as Row[];
      const statuses = (o.statuses as unknown[] | undefined)?.map(str) ?? [];
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
        shippingAddress: a && {
          name: `${str(a.first_name)} ${str(a.last_name)}`.trim(),
          phone: str(a.phone),
          address: ['address1', 'address2', 'address3', 'address4', 'address5', 'city'].map((k) => str(a[k])).filter(Boolean).join(', '),
        },
        shippingFee: str(o.shipping_fee ?? 0),
        cancelRequested: o.is_cancel_pending === true || o.need_cancel_confirm === true,
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
        })),
      };
    },
    // Tài chính (#117, lazada.md §7.6). Tên trường theo tài liệu và sàn giả lập #115, chưa đối chiếu response thật.
    async getTransactions(accessToken, from, to): Promise<SettlementTxn[]> {
      type Row = Record<string, unknown>;
      const out: SettlementTxn[] = [];
      for (let offset = 0; ; offset += TXN_PAGE) {
        const params = { access_token: accessToken, start_time: from, end_time: to, limit: String(TXN_PAGE), offset: String(offset) };
        const body = await call(config.apiUrl, '/finance/transaction/details/get', params, 'GET');
        const rows = (body.data as Row[] | undefined) ?? [];
        for (const r of rows) {
          out.push({
            txnId: String(r.transaction_number ?? ''),
            externalOrderId: r.order_no ? String(r.order_no) : null,
            date: String(r.transaction_date ?? '').slice(0, 10),
            feeName: String(r.fee_name ?? ''),
            transactionType: String(r.transaction_type ?? ''),
            amount: String(r.amount ?? '0'),
            withholding: String(r.WHT_amount ?? '0'),
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
