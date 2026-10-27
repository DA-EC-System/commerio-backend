// Smoke test Lazada Open Platform: tạo link uỷ quyền, đổi code lấy token, gọi ba API của gian hàng.
// Cách chạy: scripts/smoke/README.md
import { createHmac } from 'node:crypto';
import { loadTokens, printStep, requireEnv, saveTokens } from './token-store.ts';

const AUTH_URL = 'https://auth.lazada.com';
const API_URL = process.env.LAZADA_API_URL ?? 'https://api.lazada.vn/rest';

type LazadaTokens = { accessToken: string; refreshToken: string; expireAt: string; account: string };
type LazadaResponse = { code?: string; message?: string; request_id?: string; [key: string]: unknown };

// Chuỗi ký: apiPath + các cặp key+value xếp theo key; HMAC-SHA256 bằng app secret, hex viết hoa
function sign(apiPath: string, params: Record<string, string>): string {
  const base = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], apiPath);
  return createHmac('sha256', requireEnv('LAZADA_APP_SECRET')).update(base).digest('hex').toUpperCase();
}

async function call(
  baseUrl: string,
  apiPath: string,
  params: Record<string, string>,
  method: 'GET' | 'POST' = 'GET',
): Promise<LazadaResponse> {
  const all: Record<string, string> = {
    app_key: requireEnv('LAZADA_APP_KEY'),
    timestamp: String(Date.now()),
    sign_method: 'sha256',
    ...params,
  };
  const query = new URLSearchParams({ ...all, sign: sign(apiPath, all) });
  const res = await fetch(`${baseUrl}${apiPath}?${query}`, { method });
  const text = await res.text();
  try {
    return JSON.parse(text) as LazadaResponse;
  } catch {
    return { code: `http_${res.status}`, message: text.slice(0, 500) };
  }
}

// Lazada trả code "0" khi thành công
function isOk(res: LazadaResponse): boolean {
  return res.code === '0';
}

function storeTokens(res: LazadaResponse): void {
  saveTokens('lazada', {
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
    expireAt: new Date(Date.now() + Number(res.expires_in ?? 0) * 1000).toISOString(),
    account: res.account,
  } satisfies Record<keyof LazadaTokens, unknown>);
}

async function authUrl(): Promise<void> {
  const query = new URLSearchParams({
    response_type: 'code',
    force_auth: 'true',
    redirect_uri: requireEnv('LAZADA_REDIRECT_URL'),
    client_id: requireEnv('LAZADA_APP_KEY'),
  });
  console.log('Mở link sau, đăng nhập bằng tài khoản seller Lazada VN, rồi lấy code trên thanh địa chỉ:\n');
  console.log(`${AUTH_URL}/oauth/authorize?${query}`);
}

async function token(code: string | undefined): Promise<void> {
  if (!code) throw new Error('Cú pháp: token <code>');
  const res = await call(`${AUTH_URL}/rest`, '/auth/token/create', { code }, 'POST');
  printStep('auth/token/create', isOk(res), res);
  if (isOk(res)) storeTokens(res);
}

async function refresh(): Promise<void> {
  const saved = loadTokens<LazadaTokens>('lazada');
  const res = await call(`${AUTH_URL}/rest`, '/auth/token/refresh', { refresh_token: saved.refreshToken }, 'POST');
  printStep('auth/token/refresh', isOk(res), res);
  if (isOk(res)) storeTokens(res);
}

// Token lấy bằng nút "Get Token" ở Testing Tools → Create Test Case (tài khoản mượn) thì đặt vào
// LAZADA_ACCESS_TOKEN, khỏi đi luồng uỷ quyền
function accessToken(): string {
  const fromEnv = process.env.LAZADA_ACCESS_TOKEN;
  if (fromEnv) return fromEnv;
  const saved = loadTokens<LazadaTokens>('lazada');
  if (new Date(saved.expireAt) < new Date()) console.log('access_token đã hết hạn, chạy "refresh" trước.');
  return saved.accessToken;
}

async function check(): Promise<void> {
  const access_token = accessToken();
  const createdAfter = new Date(Date.now() - 30 * 86400_000).toISOString();
  const steps: [string, string, Record<string, string>][] = [
    ['Thông tin seller', '/seller/get', { access_token }],
    ['Danh sách sản phẩm', '/products/get', { access_token, filter: 'all', limit: '10' }],
    ['Đơn hàng 30 ngày qua', '/orders/get', { access_token, created_after: createdAfter, limit: '20' }],
  ];
  let failed = 0;
  for (const [name, path, params] of steps) {
    const res = await call(API_URL, path, params);
    printStep(`${name} (${path})`, isOk(res), res);
    if (!isOk(res)) failed++;
  }
  console.log(`\nLazada: ${steps.length - failed}/${steps.length} API gọi được`);
  if (failed) process.exitCode = 1;
}

// Gọi một API bất kỳ để thử tay: call GET /orders/get created_after=2026-10-01T00:00:00+07:00 limit=5
async function callApi(method: string | undefined, path: string | undefined, pairs: string[]): Promise<void> {
  if ((method !== 'GET' && method !== 'POST') || !path) throw new Error('Cú pháp: call GET|POST <path> [key=value ...]');
  const params: Record<string, string> = { access_token: accessToken() };
  for (const pair of pairs) {
    const i = pair.indexOf('=');
    if (i > 0) params[pair.slice(0, i)] = pair.slice(i + 1);
  }
  const res = await call(API_URL, path, params, method);
  console.log(JSON.stringify(res, null, 2));
  if (!isOk(res)) process.exitCode = 1;
}

const [command, ...args] = process.argv.slice(2);
const commands: Record<string, () => Promise<void>> = {
  'auth-url': authUrl,
  token: () => token(args[0]),
  refresh,
  check,
  call: () => callApi(args[0], args[1], args.slice(2)),
};
const run = command ? commands[command] : undefined;
if (!run) {
  console.log('Lệnh: auth-url | token <code> | refresh | check | call GET|POST <path> [key=value ...]');
  process.exitCode = 1;
} else {
  await run().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
