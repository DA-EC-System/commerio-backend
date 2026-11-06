// Smoke test TikTok Shop bằng chính adapter của app (#217): link uỷ quyền, đổi code, đọc gian hàng, làm mới, đọc SKU;
// yêu cầu trả, lần huỷ, lý do huỷ (#227).
// Chỉ gọi API đọc và API token. Token lưu ở .smoke-tokens.json (khoá `tiktok`, đã gitignore), không in ra đầy đủ.
// Smoke test TikTok Shop bằng chính adapter của app (#217): link uỷ quyền, đổi code, đọc gian hàng, làm mới, đọc SKU.
// #226, #219: kho, danh mục, thuộc tính, đẩy tồn, giá, tắt, bật, tải ảnh, tạo sản phẩm. Lệnh ghi chỉ dùng trên shop thử
// của nhóm (SANDBOX) và đặt lại giá trị cũ sau khi thử. Mỗi lời gọi Open API in path, `code`, `request_id`.
// Token lưu ở .smoke-tokens.json (khoá `tiktok`, đã gitignore), không in ra đầy đủ.
// Cách chạy: scripts/smoke/README.md
import { randomUUID } from 'node:crypto';
import { MarketplaceError, type ShopConnection } from '../../src/modules/channel/channel/service/marketplaces/common.ts';
import { createTiktokClient, packTiktokToken, unpackTiktokToken } from '../../src/modules/channel/channel/service/marketplaces/tiktok-client.ts';
import { createTiktokAdapter } from '../../src/modules/channel/channel/service/marketplaces/tiktok.ts';
import { loadTokens, printStep, requireEnv, saveTokens } from './token-store.ts';

/** Định dạng lưu: token thô của sàn, hạn là mốc Unix (giây), mỗi gian hàng kèm cipher. */
type StoredShop = { id: string; name: string; region: string | null; cipher: string };
type TiktokTokens = {
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: number | null;
  refreshExpiresAt: number | null;
  shops: StoredShop[];
};

const config = {
  appKey: requireEnv('TIKTOK_APP_KEY'),
  appSecret: requireEnv('TIKTOK_APP_SECRET'),
  serviceId: process.env.TIKTOK_SERVICE_ID,
  apiUrl: process.env.TIKTOK_API_URL ?? 'https://open-api.tiktokglobalshop.com',
  authUrl: process.env.TIKTOK_AUTH_URL ?? 'https://auth.tiktok-shops.com',
};

/** In path, `code`, `message`, `request_id` của mỗi lời gọi Open API (không in token, query ký). */
const loggingFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  const url = new URL(String(input));
  if (url.origin === config.apiUrl) {
    const body = (await res
      .clone()
      .json()
      .catch(() => ({}))) as { code?: unknown; message?: unknown; request_id?: unknown };
    const failed = body.code !== 0 ? ` message=${String(body.message)}` : '';
    console.log(`  ${init?.method ?? 'GET'} ${url.pathname} → HTTP ${res.status} code=${String(body.code)} request_id=${String(body.request_id)}${failed}`);
  }
  return res;
};

const adapter = createTiktokAdapter(config, loggingFetch);
const client = createTiktokClient(config, loggingFetch);

/** Che bí mật khi in: 6 ký tự đầu và độ dài. */
const mask = (s: string | null | undefined) => (s ? `${s.slice(0, 6)}…(${s.length} ký tự)` : null);
const unix = (d: Date | null) => (d ? Math.floor(d.getTime() / 1000) : null);
const iso = (t: number | null) => (t ? new Date(t * 1000).toISOString() : null);

function store(connections: ShopConnection[]): void {
  const first = connections[0];
  if (!first) throw new Error('Sàn không trả gian hàng nào');
  const access = unpackTiktokToken(first.tokens.accessToken);
  const refresh = first.tokens.refreshToken ? unpackTiktokToken(first.tokens.refreshToken) : null;
  saveTokens('tiktok', {
    accessToken: access.token,
    refreshToken: refresh?.token ?? null,
    accessExpiresAt: unix(first.tokens.accessExpiresAt),
    refreshExpiresAt: unix(first.tokens.refreshExpiresAt),
    shops: connections.map((c) => ({ id: c.externalShopId, name: c.shopName, region: c.region, cipher: unpackTiktokToken(c.tokens.accessToken).cipher })),
  } satisfies TiktokTokens);
}

function show(connections: ShopConnection[]) {
  return connections.map((c) => ({
    id: c.externalShopId,
    name: c.shopName,
    region: c.region,
    cipher: mask(unpackTiktokToken(c.tokens.accessToken).cipher),
    accessExpiresAt: c.tokens.accessExpiresAt?.toISOString() ?? null,
    refreshExpiresAt: c.tokens.refreshExpiresAt?.toISOString() ?? null,
  }));
}

/** Token đã gói cho gian hàng `shopId` (mặc định gian hàng đầu), như app lưu sau khi nối. */
function packedFor(saved: TiktokTokens, shopId?: string, kind: 'access' | 'refresh' = 'access'): string {
  const shop = shopId ? saved.shops.find((s) => s.id === shopId) : saved.shops[0];
  if (!shop) throw new Error(shopId ? `Không có gian hàng ${shopId} trong token đã lưu` : 'Token đã lưu chưa có gian hàng, chạy "shops"');
  const token = kind === 'access' ? saved.accessToken : saved.refreshToken;
  if (!token) throw new Error('Token đã lưu không có refresh token');
  return packTiktokToken({ token, cipher: shop.cipher, shopId: shop.id });
}

function link(): void {
  // State ở đây chỉ để thấy TikTok trả lại nguyên vẹn; smoke không kiểm như callback của app.
  const state = `smoke-${randomUUID().slice(0, 8)}`;
  console.log('Mở link sau bằng trình duyệt đã đăng nhập test seller, bấm Authorize, rồi chép nguyên URL trên thanh địa chỉ:\n');
  console.log(adapter.authorizeUrl(state));
  console.log(`\nstate mong đợi trên URL callback: ${state}`);
}

async function token(input: string | undefined): Promise<void> {
  if (!input) throw new Error('Cú pháp: token <URL callback | code>');
  const params = /^https?:\/\//i.test(input)
    ? Object.fromEntries([...new URL(input).searchParams].filter(([k]) => k !== 'state'))
    : { code: input };
  const connections = await adapter.exchangeCode(params);
  printStep('token/get + authorization/202309/shops', true, show(connections));
  store(connections);
}

async function shops(): Promise<void> {
  const saved = loadTokens<TiktokTokens>('tiktok');
  const connections = await adapter.connectWithToken({ accessToken: saved.accessToken, refreshToken: null });
  printStep('authorization/202309/shops', true, show(connections));
  // Giữ hạn đã lưu: đọc gian hàng không trả hạn.
  saveTokens('tiktok', { ...saved, shops: connections.map((c) => ({ id: c.externalShopId, name: c.shopName, region: c.region, cipher: unpackTiktokToken(c.tokens.accessToken).cipher })) });
}

async function refresh(): Promise<void> {
  const saved = loadTokens<TiktokTokens>('tiktok');
  const tokens = await adapter.refreshToken(packedFor(saved, undefined, 'refresh'));
  const a = unpackTiktokToken(tokens.accessToken);
  // Refresh xong token cũ có thể hết hiệu lực: lưu cặp mới ngay, giữ danh sách gian hàng và cipher.
  saveTokens('tiktok', {
    ...saved,
    accessToken: a.token,
    refreshToken: tokens.refreshToken ? unpackTiktokToken(tokens.refreshToken).token : saved.refreshToken,
    accessExpiresAt: unix(tokens.accessExpiresAt),
    refreshExpiresAt: unix(tokens.refreshExpiresAt),
  } satisfies TiktokTokens);
  printStep('token/refresh', true, {
    accessToken: mask(a.token),
    cipherGiữNguyên: a.cipher === saved.shops[0]?.cipher,
    accessExpiresAt: tokens.accessExpiresAt?.toISOString() ?? null,
    refreshExpiresAt: tokens.refreshExpiresAt?.toISOString() ?? null,
  });
}

async function skus(shopId: string | undefined, sellerSkus: string[]): Promise<void> {
  const saved = loadTokens<TiktokTokens>('tiktok');
  if (saved.accessExpiresAt && saved.accessExpiresAt * 1000 < Date.now()) console.log(`access token hết hạn từ ${iso(saved.accessExpiresAt)}, chạy "refresh" trước.`);
  const packed = packedFor(saved, shopId);
  const list = sellerSkus.length ? await adapter.getSkus(packed, sellerSkus) : await adapter.listSkus!(packed);
  printStep(sellerSkus.length ? 'getSkus (product/202502/products/search)' : 'listSkus (product/202502/products/search)', true, {
    count: list.length,
    items: list.slice(0, 20),
  });
}

/** Yêu cầu trả hay lần huỷ cập nhật trong `days` ngày qua (#227), lật hết trang. Chỉ đọc. */
async function aftersales(kind: 'returns' | 'cancellations', days: string | undefined): Promise<void> {
  const saved = loadTokens<TiktokTokens>('tiktok');
  const packed = packedFor(saved);
  const since = new Date(Date.now() - (Number(days) || 30) * 86_400_000);
  const list = kind === 'returns' ? adapter.listReturns! : adapter.listCancellations!;
  const items: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const res: { items: unknown[]; nextCursor: string | null } = await list(packed, since, cursor);
    items.push(...res.items);
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  printStep(`${kind === 'returns' ? 'listReturns (return_refund/202602/returns/search)' : 'listCancellations (return_refund/202602/cancellations/search)'} từ ${since.toISOString()}`, true, { count: items.length, items });
}

/** Lý do người bán huỷ được đơn (#227, Get Aftersale Eligibility 202602). Chỉ đọc, không huỷ. */
async function cancelReasons(orderId: string | undefined): Promise<void> {
  if (!orderId) throw new Error('Cú pháp: cancel-reasons <orderId>');
  const saved = loadTokens<TiktokTokens>('tiktok');
  printStep('cancelReasons (return_refund/202602/orders/{id}/aftersale_eligibility)', true, await adapter.cancelReasons!(packedFor(saved), orderId, []));
}

function session(): string {
  const saved = loadTokens<TiktokTokens>('tiktok');
  if (saved.accessExpiresAt && saved.accessExpiresAt * 1000 < Date.now()) console.log(`access token hết hạn từ ${iso(saved.accessExpiresAt)}.`);
  return packedFor(saved);
}

/** SKU sàn theo SellerSku (đọc trạng thái, tồn hiện có trước khi ghi). */
async function skuOf(packed: string, sellerSku: string) {
  const [sku] = await adapter.getSkus(packed, [sellerSku]);
  if (!sku) throw new Error(`Không có SellerSku ${sellerSku} trên gian hàng`);
  return sku;
}

async function warehouses(): Promise<void> {
  const data = await client.call<{ warehouses?: Record<string, unknown>[] }>('GET', '/logistics/202309/warehouses', { token: session() });
  const rows = (data?.warehouses ?? []).map((w) => ({ id: w.id, name: w.name, type: w.type, is_default: w.is_default, effect_status: w.effect_status }));
  printStep('logistics/202309/warehouses', true, rows);
}

async function categories(keyword: string | undefined): Promise<void> {
  const all = await adapter.listCategories(session());
  const q = keyword?.toLocaleLowerCase('vi');
  const hit = q ? all.filter((c) => c.name.toLocaleLowerCase('vi').includes(q)) : all;
  printStep('product/202309/categories (lá AVAILABLE)', true, { leaves: all.length, matched: hit.length, items: hit.slice(0, 15) });
}

async function attrs(categoryId: string | undefined): Promise<void> {
  if (!categoryId) throw new Error('Cú pháp: attrs <categoryId>');
  printStep('product/202309/categories/{id}/attributes (bắt buộc)', true, await adapter.categoryAttributes(session(), categoryId));
}

async function pushStock(sellerSku: string | undefined, qty: string | undefined): Promise<void> {
  if (!sellerSku || qty === undefined) throw new Error('Cú pháp: push-stock <sellerSku> <qty>');
  const packed = session();
  const before = await skuOf(packed, sellerSku);
  const item = { externalProductId: before.externalProductId, externalSkuId: before.externalSkuId, quantity: Number(qty) };
  const result = await adapter.updatePriceQuantity(packed, [item]);
  const after = await skuOf(packed, sellerSku);
  printStep('updatePriceQuantity (tồn)', result.every((r) => r.ok), { before: before.quantity, sent: Number(qty), after: after.quantity, result });
}

async function pushPrice(sellerSku: string | undefined, price: string | undefined): Promise<void> {
  if (!sellerSku || !price) throw new Error('Cú pháp: push-price <sellerSku> <giá VND>');
  const packed = session();
  const sku = await skuOf(packed, sellerSku);
  const result = await adapter.updatePriceQuantity(packed, [{ externalProductId: sku.externalProductId, externalSkuId: sku.externalSkuId, price }]);
  printStep('updatePriceQuantity (giá)', result.every((r) => r.ok), { state: sku.state, sent: price, result });
}

async function toggle(action: 'deactivate' | 'activate', sellerSku: string | undefined): Promise<void> {
  if (!sellerSku) throw new Error(`Cú pháp: ${action} <sellerSku>`);
  const packed = session();
  const sku = await skuOf(packed, sellerSku);
  await adapter[action]!(packed, sku.externalProductId, sku.externalSkuId);
  const after = await skuOf(packed, sellerSku);
  printStep(action, true, { productId: sku.externalProductId, before: sku.state, after: after.state });
}

async function uploadImage(url: string | undefined): Promise<void> {
  if (!url) throw new Error('Cú pháp: upload-image <URL ảnh>');
  printStep('uploadImage (product/202309/images/upload)', true, { uri: await adapter.uploadImage(session(), url) });
}

/** Tạo một sản phẩm thử tên bắt đầu `CM-TEST-` (#219); thuộc tính truyền `mã=giá trị`. */
async function createProduct(categoryId: string | undefined, imageUrl: string | undefined, rest: string[]): Promise<void> {
  if (!categoryId || !imageUrl) throw new Error('Cú pháp: create-product <categoryId> <URL ảnh> [mãThuộcTính=giáTrị ...]');
  const packed = session();
  const uri = await adapter.uploadImage(packed, imageUrl);
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 12);
  const created = await adapter.createProduct(packed, {
    externalCategoryId: categoryId,
    attributes: Object.fromEntries(rest.map((a) => a.split('=') as [string, string])),
    name: `CM-TEST-${stamp} Sản phẩm thử API Commerio, không bán`,
    description: 'Sản phẩm thử của đồ án Commerio, tạo bằng API để kiểm adapter. Không bán.',
    imageUrls: [uri],
    sellerSku: `CM-TEST-${stamp}`,
    price: '99000',
    quantity: 5,
    weightG: 300,
    lengthMm: 100,
    widthMm: 100,
    heightMm: 100,
  });
  printStep('createProduct (product/202309/products)', true, created);
}

const [command, ...args] = process.argv.slice(2);
const commands: Record<string, () => Promise<void> | void> = {
  link,
  token: () => token(args[0]),
  shops,
  refresh,
  // skus [shopId] [sellerSku ...]
  skus: () => skus(args[0] && /^\d+$/.test(args[0]) ? args[0] : undefined, args.filter((a, i) => !(i === 0 && /^\d+$/.test(a)))),
  // returns [số ngày], cancellations [số ngày], cancel-reasons <orderId> (#227, chỉ đọc)
  returns: () => aftersales('returns', args[0]),
  cancellations: () => aftersales('cancellations', args[0]),
  'cancel-reasons': () => cancelReasons(args[0]),
  warehouses,
  categories: () => categories(args[0]),
  attrs: () => attrs(args[0]),
  'push-stock': () => pushStock(args[0], args[1]),
  'push-price': () => pushPrice(args[0], args[1]),
  deactivate: () => toggle('deactivate', args[0]),
  activate: () => toggle('activate', args[0]),
  'upload-image': () => uploadImage(args[0]),
  'create-product': () => createProduct(args[0], args[1], args.slice(2)),
};
const run = command ? commands[command] : undefined;
if (!run) {
  console.log(
    'Lệnh: link | token <URL callback | code> | shops | refresh | skus [shopId] [sellerSku ...] | warehouses | categories [từ khoá] |\n' +
      '  attrs <categoryId> | push-stock <sellerSku> <qty> | push-price <sellerSku> <giá> | deactivate <sellerSku> | activate <sellerSku> |\n' +
      '  upload-image <URL ảnh> | create-product <categoryId> <URL ảnh> [mãThuộcTính=giáTrị ...] |\n' +
      '  returns [ngày] | cancellations [ngày] | cancel-reasons <orderId>',
  );
  process.exitCode = 1;
} else {
  try {
    await run();
  } catch (err) {
    if (err instanceof MarketplaceError) printStep(command!, false, { kind: err.kind, platformCode: err.platformCode, platformMessage: err.platformMessage });
    else console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
