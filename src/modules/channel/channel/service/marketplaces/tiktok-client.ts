// Client HTTP dùng chung của TikTok Shop (#217): ký request, gói token kèm shop cipher, đổi lỗi về `MarketplaceError`.
// Các phần adapter TikTok (đơn, kiện, tồn giá, huỷ trả) gọi sàn qua `client.call` ở đây, không tự ký.
// Nguồn (docv2, tra 06/11/2026):
// - Ký: https://partner.tiktokshop.com/docv2/page/sign-your-api-request
// - Mã lỗi chung: https://partner.tiktokshop.com/docv2/page/common-errors
// - Token: https://partner.tiktokshop.com/docv2/page/authorization-overview-202407
import { createHmac } from 'node:crypto';
import { MarketplaceError } from './common.ts';
import { createRateLimiter } from './rate-limit.ts';

export interface TiktokConfig {
  appKey: string | undefined;
  appSecret: string | undefined;
  /** `service_id` của app trên Partner Center, chỉ cần cho link uỷ quyền. */
  serviceId: string | undefined;
  /** Gốc Open API, mặc định `https://open-api.tiktokglobalshop.com`. */
  apiUrl: string;
  /** Gốc máy chủ token, mặc định `https://auth.tiktok-shops.com`. */
  authUrl: string;
  /** Xin một lượt trong hạn mức gọi của app trước mỗi request; `false` là hết lượt hôm nay. */
  reserveCall?: () => Promise<boolean>;
  /**
   * Giãn lời gọi theo gian hàng (#215 phần TikTok). TikTok giới hạn QPS động theo app × gian hàng, không có hạn mức ngày
   * (docv2 Rate limits, tra 06/11/2026: gợi ý đọc 3–10 req/s, ghi 1–3 req/s mỗi gian hàng). Không đặt thì không giãn,
   * không gọi lại (test). Có đặt: bị 429/36009002 thì lùi `backoffMs` rồi gọi lại một lần.
   */
  rateLimit?: TiktokRateLimit;
}

export interface TiktokRateLimit {
  readPerSecond: number;
  writePerSecond: number;
  backoffMs: number;
}

/** Mặc định chạy thật: giữa khoảng gợi ý của TikTok, chừa chỗ cho tiến trình khác cùng gọi. */
export const TIKTOK_RATE_LIMIT: TiktokRateLimit = { readPerSecond: 5, writePerSecond: 2, backoffMs: 1000 };

/** Lời gọi chỉ đọc: GET, và POST tìm kiếm (Search Products, Get Order List dùng POST có body lọc). */
function isRead(method: TiktokMethod, path: string): boolean {
  return method === 'GET' || /\/search$/.test(path);
}

const isRateLimited = (err: unknown) =>
  err instanceof MarketplaceError && (err.platformCode === '36009002' || err.platformCode === 'http_429');

const TIMEOUT_MS = 10_000;

/**
 * Chữ ký request (docv2 "Sign your API request"): query bỏ `sign`, `access_token`, xếp theo tên, nối `{key}{value}`;
 * đặt sau path; nối body nếu không phải multipart; bọc app secret hai đầu; HMAC-SHA256 khoá app secret, hex thường.
 * `body` phải đúng chuỗi gửi đi (không parse rồi serialize lại).
 */
export function signTiktok(path: string, query: Readonly<Record<string, string>>, body: string, secret: string): string {
  const params = Object.keys(query)
    .filter((k) => k !== 'sign' && k !== 'access_token')
    .sort()
    .map((k) => k + query[k])
    .join('');
  return createHmac('sha256', secret).update(`${secret}${path}${params}${body}${secret}`).digest('hex');
}

// Lỗi tạm, thử lại được: 36009002 quá tần suất (cùng HTTP 429), 36009003 lỗi nội bộ, 36009007 hết giờ (common-errors).
const TRANSIENT_CODES = new Set(['36009002', '36009003', '36009007']);
// Token sai hoặc hết hạn: gian hàng cần nối lại. 105002 hết hạn (common-errors); 36009005 token sai (gọi thật 02/11 và
// 06/11/2026, câu "The 'access_token' header is invalid", không có trong trang mã lỗi chung); 101000 token không thuộc gian hàng hoặc không khớp `shop_cipher`.
const AUTH_CODES = new Set(['105002', '36009005', '101000']);
// 36009004 dùng chung cho nhiều lỗi kiểm request, docs bảo phân biệt theo câu: chỉ câu về token là mất uỷ quyền.
// Gọi thật 06/11/2026: câu có dấu nháy (`The 'access_token' header is invalid`), nên nhận cả hai dạng.
const AUTH_MESSAGE_36009004 = /(x-tts-access-token|access_token)'? header is invalid/i;

/** Mã lỗi trong body (`code` khác 0) đổi sang loại của app; mã và câu gốc giữ ở `platformCode`, `platformMessage`. */
export function tiktokError(code: unknown, message: unknown): MarketplaceError {
  const c = String(code ?? 'unknown');
  const m = typeof message === 'string' ? message : null;
  if (TRANSIENT_CODES.has(c)) return new MarketplaceError('unavailable', c, m);
  if (AUTH_CODES.has(c) || (c === '36009004' && m !== null && AUTH_MESSAGE_36009004.test(m))) {
    return new MarketplaceError('unauthorized', c, m);
  }
  return new MarketplaceError('rejected', c, m);
}

/**
 * Token TikTok trong `TokenSet` là chuỗi mờ (#200): `tts1.` + base64url của JSON `{ t, c, s }` = token của sàn, shop
 * cipher, mã shop. Mọi API theo gian hàng cần `shop_cipher`, mà làm mới token không trả cipher, nên cả access lẫn refresh
 * đều mang cipher. Đổi định dạng thì tăng `tts1` và giữ đường đọc bản cũ.
 */
export interface TiktokTokenParts {
  token: string;
  cipher: string;
  shopId: string;
}

const PREFIX = 'tts1.';

export function packTiktokToken(p: TiktokTokenParts): string {
  return PREFIX + Buffer.from(JSON.stringify({ t: p.token, c: p.cipher, s: p.shopId })).toString('base64url');
}

/** Chuỗi không đúng định dạng thì `unauthorized`: token lưu hỏng hay không do adapter tạo, gian hàng phải nối lại. */
export function unpackTiktokToken(packed: string): TiktokTokenParts {
  const bad = () => new MarketplaceError('unauthorized', 'token_format', 'Token TikTok lưu không đúng định dạng, cần kết nối lại');
  if (!packed.startsWith(PREFIX)) throw bad();
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(packed.slice(PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  const o = raw as { t?: unknown; c?: unknown; s?: unknown } | null;
  if (typeof o?.t !== 'string' || !o.t || typeof o.c !== 'string' || typeof o.s !== 'string') throw bad();
  return { token: o.t, cipher: o.c, shopId: o.s };
}

export type TiktokMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface TiktokCallOptions {
  query?: Record<string, string | number | undefined>;
  /** Body JSON; serialize một lần, ký và gửi cùng một chuỗi. */
  body?: unknown;
  /** Token đã gói (`TokenSet.accessToken`): client tự đặt header `x-tts-access-token` và `shop_cipher`. */
  token?: string;
  /** Mặc định true. API không theo gian hàng (vd Get Authorized Shops) đặt false: gửi `shop_cipher` thừa sàn báo 36009004. */
  shopCipher?: boolean;
}

/** Phản hồi chung của TikTok: `{ code, message, request_id, data }`; `code` 0 là thành công. */
type TiktokResponse = { code?: unknown; message?: unknown; request_id?: unknown; data?: unknown };

export interface TiktokClient {
  readonly config: TiktokConfig;
  /** Có app key và secret: gọi được Open API và máy chủ token. */
  readonly hasCredentials: boolean;
  /**
   * Gọi Open API đã ký, trả `data` khi `code` = 0, không thì ném `MarketplaceError`. Thiếu cấu hình ném `unsupported`
   * trước khi gọi mạng; hết hạn mức ngày ném `unavailable` `daily_call_limit`.
   */
  call<T = unknown>(method: TiktokMethod, path: string, opts?: TiktokCallOptions): Promise<T>;
  /** Như `call` nhưng nhận access token thô của sàn (chưa có cipher), chỉ cho lúc nối gian hàng. */
  callRaw<T = unknown>(method: TiktokMethod, path: string, rawToken: string, opts?: Omit<TiktokCallOptions, 'token' | 'shopCipher'>): Promise<T>;
  /** Gọi máy chủ token (`/api/v2/token/get`, `/api/v2/token/refresh`): không ký, app secret đi trong query theo docs. */
  callAuth<T = unknown>(path: string, query: Record<string, string>): Promise<T>;
}

export function createTiktokClient(config: TiktokConfig, fetchFn: typeof fetch = fetch): TiktokClient {
  const hasCredentials = Boolean(config.appKey && config.appSecret);
  const limiter = config.rateLimit ? createRateLimiter() : null;

  function credentials() {
    if (!hasCredentials) throw new MarketplaceError('unsupported');
    return { appKey: config.appKey!, appSecret: config.appSecret! };
  }

  async function reserve() {
    if (config.reserveCall && !(await config.reserveCall())) {
      throw new MarketplaceError('unavailable', 'daily_call_limit', 'Đã dùng hết hạn mức gọi TikTok trong ngày');
    }
  }

  async function send(url: string, init: RequestInit): Promise<TiktokResponse> {
    let res: Response;
    try {
      res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new MarketplaceError('unavailable');
    }
    // 429 là quá tần suất, 5xx là sàn lỗi hay bảo trì (docv2 Rate limits, tra 06/11/2026): đều thử lại sau.
    if (res.status >= 500 || res.status === 429) throw new MarketplaceError('unavailable', `http_${res.status}`);
    let body: TiktokResponse;
    try {
      body = (await res.json()) as TiktokResponse;
    } catch {
      throw new MarketplaceError('unavailable', `http_${res.status}`);
    }
    if (body.code !== 0 && body.code !== '0') throw tiktokError(body.code, body.message);
    return body;
  }

  /**
   * Giãn theo `<mã shop>:<đọc|ghi>` rồi gửi; bị giới hạn tần suất thì lùi cả khoá, gọi lại một lần (request bị từ chối nên
   * gửi lại ghi không trùng). Chữ ký có `timestamp` nên mỗi lần gửi ký lại (`build`).
   */
  async function limited<T>(scope: string, method: TiktokMethod, path: string, send: () => Promise<T>): Promise<T> {
    const rl = config.rateLimit;
    if (!rl || !limiter) return send();
    const key = `${scope}:${isRead(method, path) ? 'read' : 'write'}`;
    const interval = 1000 / (isRead(method, path) ? rl.readPerSecond : rl.writePerSecond);
    await limiter.acquire(key, interval);
    try {
      return await send();
    } catch (err) {
      if (!isRateLimited(err)) throw err;
      limiter.backoff(key, rl.backoffMs);
      await limiter.acquire(key, interval);
      return send();
    }
  }

  async function signedCall<T>(
    method: TiktokMethod,
    path: string,
    rawToken: string | null,
    cipher: string | null,
    opts: TiktokCallOptions,
    scope = 'app',
  ) {
    return limited(scope, method, path, () => signedOnce<T>(method, path, rawToken, cipher, opts));
  }

  async function signedOnce<T>(method: TiktokMethod, path: string, rawToken: string | null, cipher: string | null, opts: TiktokCallOptions) {
    const { appKey, appSecret } = credentials();
    await reserve();
    const query: Record<string, string> = { app_key: appKey, timestamp: String(Math.floor(Date.now() / 1000)) };
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) query[k] = String(v);
    if (cipher) query.shop_cipher = cipher;
    const body = opts.body === undefined ? '' : JSON.stringify(opts.body);
    const sign = signTiktok(path, query, body, appSecret);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (rawToken) headers['x-tts-access-token'] = rawToken;
    const url = `${config.apiUrl}${path}?${new URLSearchParams({ ...query, sign })}`;
    const res = await send(url, { method, headers, ...(body && { body }) });
    return res.data as T;
  }

  return {
    config,
    hasCredentials,
    async call<T>(method: TiktokMethod, path: string, opts: TiktokCallOptions = {}) {
      const parts = opts.token === undefined ? null : unpackTiktokToken(opts.token);
      const cipher = opts.shopCipher === false ? null : (parts?.cipher ?? null);
      return signedCall<T>(method, path, parts?.token ?? null, cipher, opts, parts?.shopId ?? 'app');
    },
    async callRaw<T>(method: TiktokMethod, path: string, rawToken: string, opts: Omit<TiktokCallOptions, 'token' | 'shopCipher'> = {}) {
      return signedCall<T>(method, path, rawToken, null, opts);
    },
    async callAuth<T>(path: string, query: Record<string, string>) {
      const { appKey, appSecret } = credentials();
      await reserve();
      const qs = new URLSearchParams({ app_key: appKey, app_secret: appSecret, ...query });
      const res = await send(`${config.authUrl}${path}?${qs}`, { method: 'GET' });
      return res.data as T;
    },
  };
}
