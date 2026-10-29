// Smoke test eBay Sandbox (REST Sell API): lấy user token, gọi quyền bán, tồn kho, đơn hàng.
// Cách chạy: scripts/smoke/README.md
import { loadTokens, printStep, requireEnv, saveTokens } from './token-store.ts';

const API_URL = process.env.EBAY_API_URL ?? 'https://api.sandbox.ebay.com';
// Finances API nằm ở host riêng (apiz); gọi qua API_URL thì trả 404
const APIZ_URL = process.env.EBAY_APIZ_URL ?? 'https://apiz.sandbox.ebay.com';
const AUTH_URL = process.env.EBAY_AUTH_URL ?? 'https://auth.sandbox.ebay.com';
const SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  'https://api.ebay.com/oauth/api_scope/sell.finances',
].join(' ');

type EbayTokens = { accessToken: string; refreshToken?: string; expireAt: string };
type EbayResponse = { errors?: unknown[]; [key: string]: unknown };

function basicAuth(): string {
  const raw = `${requireEnv('EBAY_CLIENT_ID')}:${requireEnv('EBAY_CLIENT_SECRET')}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
}

// Token dán tay từ trang User Tokens (EBAY_USER_TOKEN) được ưu tiên, sau đó tới token đã lưu
function accessToken(): string {
  const fromEnv = process.env.EBAY_USER_TOKEN;
  if (fromEnv) return fromEnv;
  const saved = loadTokens<EbayTokens>('ebay');
  if (new Date(saved.expireAt) < new Date()) console.log('access_token đã hết hạn, chạy "refresh" trước.');
  return saved.accessToken;
}

async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; data: EbayResponse }> {
  const host = path.startsWith('/sell/finances/') ? APIZ_URL : API_URL;
  const res = await fetch(`${host}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken()}`,
      'Content-Type': 'application/json',
      // Inventory API trả 25709 nếu thiếu Accept-Language
      'Content-Language': 'en-US',
      'Accept-Language': 'en-US',
      Accept: 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!text) return { status: res.status, data: {} };
  try {
    return { status: res.status, data: JSON.parse(text) as EbayResponse };
  } catch {
    return { status: res.status, data: { errors: [text.slice(0, 500)] } };
  }
}

async function tokenRequest(params: Record<string, string>): Promise<void> {
  const res = await fetch(`${API_URL}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = (await res.json()) as Record<string, unknown>;
  printStep('identity/v1/oauth2/token', res.ok, { ...data, access_token: '***', refresh_token: data.refresh_token ? '***' : undefined });
  if (!res.ok) return;
  const previous = params.grant_type === 'refresh_token' ? loadTokens<EbayTokens>('ebay') : undefined;
  saveTokens('ebay', {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? previous?.refreshToken,
    expireAt: new Date(Date.now() + Number(data.expires_in ?? 0) * 1000).toISOString(),
  } satisfies Record<keyof EbayTokens, unknown>);
}

// Luồng đầy đủ, có refresh token (hạn khoảng 18 tháng): cần RuName ở trang User Tokens
async function authUrl(): Promise<void> {
  const query = new URLSearchParams({
    client_id: requireEnv('EBAY_CLIENT_ID'),
    redirect_uri: requireEnv('EBAY_RUNAME'),
    response_type: 'code',
    scope: SCOPES,
  });
  console.log('Mở link sau, đăng nhập user sandbox bán hàng, bấm Agree, rồi lấy code trên thanh địa chỉ:\n');
  console.log(`${AUTH_URL}/oauth2/authorize?${query}`);
}

async function token(code: string | undefined): Promise<void> {
  if (!code) throw new Error('Cú pháp: token <code> (code lấy trên URL quay về, đã giải mã %xx cũng được)');
  await tokenRequest({ grant_type: 'authorization_code', code: decodeURIComponent(code), redirect_uri: requireEnv('EBAY_RUNAME') });
}

async function refresh(): Promise<void> {
  const saved = loadTokens<EbayTokens>('ebay');
  if (!saved.refreshToken) throw new Error('Chưa có refresh token. Chạy auth-url rồi token <code>.');
  await tokenRequest({ grant_type: 'refresh_token', refresh_token: saved.refreshToken, scope: SCOPES });
}

async function check(): Promise<void> {
  const steps: [string, string][] = [
    ['Quyền bán của tài khoản', '/sell/account/v1/privilege'],
    ['Tồn kho (Inventory items)', '/sell/inventory/v1/inventory_item?limit=10'],
    ['Đơn hàng (Fulfillment)', '/sell/fulfillment/v1/order?limit=10'],
  ];
  let failed = 0;
  for (const [name, path] of steps) {
    const { status, data } = await call('GET', path);
    const ok = status >= 200 && status < 300;
    printStep(`${name} (${path}) HTTP ${status}`, ok, data);
    if (!ok) failed++;
  }
  console.log(`\neBay: ${steps.length - failed}/${steps.length} API gọi được`);
  if (failed) process.exitCode = 1;
}

// Gọi một API bất kỳ: call GET /sell/fulfillment/v1/order?limit=5, call POST <path> '<json body>'
async function callApi(method: string | undefined, path: string | undefined, body: string | undefined): Promise<void> {
  if (!method || !['GET', 'POST', 'PUT', 'DELETE'].includes(method) || !path) {
    throw new Error('Cú pháp: call GET|POST|PUT|DELETE <path?query> [json body]');
  }
  const { status, data } = await call(method as 'GET', path, body === undefined ? undefined : JSON.parse(body));
  console.log(`HTTP ${status}`);
  console.log(JSON.stringify(data, null, 2));
  if (status >= 300) process.exitCode = 1;
}

const [command, ...args] = process.argv.slice(2);
const commands: Record<string, () => Promise<void>> = {
  'auth-url': authUrl,
  token: () => token(args[0]),
  refresh,
  check,
  call: () => callApi(args[0], args[1], args[2]),
};
const run = command ? commands[command] : undefined;
if (!run) {
  console.log('Lệnh: auth-url | token <code> | refresh | check | call GET|POST|PUT|DELETE <path> [json]');
  process.exitCode = 1;
} else {
  await run().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
