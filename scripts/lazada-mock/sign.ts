// Chữ ký Lazada cho sàn giả lập (#115). Cổng chạy trong container chỉ thấy thư mục này nên không import từ src/;
// thuật toán giống `signLazada` của adapter (src/modules/channel/channel/service/marketplaces/lazada.ts).
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Request API: HEX_UPPER(HMAC_SHA256(app_secret, apiPath + k1 + v1 + …)), các cặp xếp theo key, bỏ `sign`. */
export function signRequest(apiPath: string, params: Record<string, string>, secret: string): string {
  const base = Object.keys(params)
    .filter((k) => k !== 'sign')
    .sort()
    .reduce((acc, k) => acc + k + params[k], apiPath);
  return createHmac('sha256', secret).update(base).digest('hex').toUpperCase();
}

/** Push (Documents/tich-hop-san/lazada.md §8): header `Authorization` = hex(HMAC_SHA256(app_secret, app_key + rawBody)). */
export function signPush(rawBody: string, appKey: string, secret: string): string {
  return createHmac('sha256', secret).update(appKey + rawBody).digest('hex');
}

export type SignCheck = { ok: true } | { ok: false; code: 'IncompleteSignature' | 'InvalidAppKey'; message: string };

/** Kiểm request như Lazada: sai app_key thì `InvalidAppKey`, thiếu hoặc sai chữ ký thì `IncompleteSignature`. */
export function checkRequest(apiPath: string, params: Record<string, string>, appKey: string, secret: string): SignCheck {
  if (params.app_key !== appKey) return { ok: false, code: 'InvalidAppKey', message: 'Invalid app key' };
  const expected = signRequest(apiPath, params, secret);
  const got = params.sign ?? '';
  const same = got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  return same ? { ok: true } : { ok: false, code: 'IncompleteSignature', message: 'The request signature does not conform to platform standards' };
}
