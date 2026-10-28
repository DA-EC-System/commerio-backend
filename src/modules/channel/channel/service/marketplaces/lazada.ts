// Adapter Lazada Open Platform (Documents/tich-hop-san/lazada.md §2, §3, §7.1). Cách ký chép từ scripts/smoke/lazada.ts.
import { createHmac } from 'node:crypto';
import { type MarketplaceAdapter, MarketplaceError, type SellerInfo, type TokenSet } from './common.ts';

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
  // `ISP`, `SYSTEM`: lỗi phía sàn; `ApiCallLimit`: quá hạn mức, đều thử lại được.
  if (res.type === 'ISP' || res.type === 'SYSTEM' || code === 'ApiCallLimit') {
    return new MarketplaceError('unavailable', code, message);
  }
  return new MarketplaceError('rejected', code, message);
}

const toDate = (seconds: unknown) => (Number(seconds) > 0 ? new Date(Date.now() + Number(seconds) * 1000) : null);

export function createLazadaAdapter(config: LazadaConfig, fetchFn: typeof fetch = fetch): MarketplaceAdapter {
  function credentials() {
    if (!config.appKey || !config.appSecret) throw new MarketplaceError('unsupported');
    return { appKey: config.appKey, appSecret: config.appSecret };
  }

  async function call(baseUrl: string, apiPath: string, params: Record<string, string>, method: 'GET' | 'POST') {
    const { appKey, appSecret } = credentials();
    const all = { app_key: appKey, timestamp: String(Date.now()), sign_method: 'sha256', ...params };
    const query = new URLSearchParams({ ...all, sign: signLazada(apiPath, all, appSecret) });
    let res: Response;
    try {
      res = await fetchFn(`${baseUrl}${apiPath}?${query}`, { method, signal: AbortSignal.timeout(TIMEOUT_MS) });
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
    if (body.code !== '0') throw lazadaError(body);
    return body;
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
    authorizeUrl(state) {
      const { appKey } = credentials();
      // Chỉ OAuth cần trang callback; nối bằng token không cần.
      const redirectUrl = config.redirectUrl;
      if (!redirectUrl) throw new MarketplaceError('unsupported');
      const query = new URLSearchParams({
        response_type: 'code',
        force_auth: 'true',
        redirect_uri: redirectUrl,
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
  };
}
