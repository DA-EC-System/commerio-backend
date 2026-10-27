// Smoke test Shopee Open Platform v2: tạo link uỷ quyền, đổi code lấy token, gọi ba API cấp shop.
// Cách chạy: scripts/smoke/README.md
import { createHmac } from 'node:crypto';
import { loadTokens, printStep, requireEnv, saveTokens } from './token-store.ts';

const HOST = process.env.SHOPEE_HOST ?? 'https://partner.test-stable.shopeemobile.com';

type ShopeeTokens = { shopId: number; accessToken: string; refreshToken: string; expireAt: string };
type ShopeeResponse = { error?: string; message?: string; request_id?: string; [key: string]: unknown };

function partner() {
  return { id: Number(requireEnv('SHOPEE_PARTNER_ID')), key: requireEnv('SHOPEE_PARTNER_KEY') };
}

// Chuỗi ký: partner_id + path + timestamp, API cấp shop nối thêm access_token + shop_id
function sign(path: string, timestamp: number, shop?: { accessToken: string; shopId: number }): string {
  const { id, key } = partner();
  const base = `${id}${path}${timestamp}${shop ? `${shop.accessToken}${shop.shopId}` : ''}`;
  return createHmac('sha256', key).update(base).digest('hex');
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

async function call(
  method: 'GET' | 'POST',
  path: string,
  params: Record<string, string | number>,
  options: { body?: unknown; shop?: { accessToken: string; shopId: number } } = {},
): Promise<ShopeeResponse> {
  const timestamp = now();
  const query = new URLSearchParams({
    partner_id: String(partner().id),
    timestamp: String(timestamp),
    sign: sign(path, timestamp, options.shop),
    ...(options.shop && { access_token: options.shop.accessToken, shop_id: String(options.shop.shopId) }),
  });
  for (const [k, v] of Object.entries(params)) query.set(k, String(v));
  const res = await fetch(`${HOST}${path}?${query}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as ShopeeResponse;
  } catch {
    return { error: `http_${res.status}`, message: text.slice(0, 500) };
  }
}

function storeTokens(shopId: number, res: ShopeeResponse): void {
  const expireIn = Number(res.expire_in ?? 0);
  saveTokens('shopee', {
    shopId,
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
    expireAt: new Date(Date.now() + expireIn * 1000).toISOString(),
  } satisfies Record<keyof ShopeeTokens, unknown>);
}

async function authUrl(): Promise<void> {
  const path = '/api/v2/shop/auth_partner';
  const timestamp = now();
  const query = new URLSearchParams({
    partner_id: String(partner().id),
    timestamp: String(timestamp),
    sign: sign(path, timestamp),
    redirect: requireEnv('SHOPEE_REDIRECT_URL'),
  });
  console.log('Mở link sau (hạn 5 phút), đăng nhập bằng shop thử, rồi lấy code và shop_id trên thanh địa chỉ:\n');
  console.log(`${HOST}${path}?${query}`);
}

async function token(code: string | undefined, shopIdArg: string | undefined): Promise<void> {
  if (!code || !shopIdArg) throw new Error('Cú pháp: token <code> <shop_id>');
  const shopId = Number(shopIdArg);
  const res = await call('POST', '/api/v2/auth/token/get', {}, {
    body: { code, shop_id: shopId, partner_id: partner().id },
  });
  printStep('auth/token/get', !res.error, res);
  if (!res.error) storeTokens(shopId, res);
}

async function refresh(): Promise<void> {
  const saved = loadTokens<ShopeeTokens>('shopee');
  const res = await call('POST', '/api/v2/auth/access_token/get', {}, {
    body: { refresh_token: saved.refreshToken, shop_id: saved.shopId, partner_id: partner().id },
  });
  printStep('auth/access_token/get', !res.error, res);
  if (!res.error) storeTokens(saved.shopId, res);
}

async function check(): Promise<void> {
  const saved = loadTokens<ShopeeTokens>('shopee');
  if (new Date(saved.expireAt) < new Date()) console.log('access_token đã hết hạn, chạy "refresh" trước.');
  const shop = { accessToken: saved.accessToken, shopId: saved.shopId };
  const to = now();
  const steps: [string, string, Record<string, string | number>][] = [
    ['Thông tin shop', '/api/v2/shop/get_shop_info', {}],
    ['Danh sách sản phẩm', '/api/v2/product/get_item_list', { offset: 0, page_size: 10, item_status: 'NORMAL' }],
    // Shopee giới hạn khoảng thời gian tối đa 15 ngày
    ['Đơn hàng 15 ngày qua', '/api/v2/order/get_order_list', {
      time_range_field: 'create_time', time_from: to - 15 * 86400, time_to: to, page_size: 20,
    }],
  ];
  let failed = 0;
  for (const [name, path, params] of steps) {
    const res = await call('GET', path, params, { shop });
    printStep(`${name} (${path})`, !res.error, res);
    if (res.error) failed++;
  }
  console.log(`\nShopee: ${steps.length - failed}/${steps.length} API gọi được`);
  if (failed) process.exitCode = 1;
}

const [command, ...args] = process.argv.slice(2);
const commands: Record<string, () => Promise<void>> = {
  'auth-url': authUrl,
  token: () => token(args[0], args[1]),
  refresh,
  check,
};
const run = command ? commands[command] : undefined;
if (!run) {
  console.log('Lệnh: auth-url | token <code> <shop_id> | refresh | check');
  process.exitCode = 1;
} else {
  await run().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
