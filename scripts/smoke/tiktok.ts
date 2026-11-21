// Smoke test TikTok Shop bằng chính adapter của app (#217): link uỷ quyền, đổi code, đọc gian hàng, làm mới, đọc SKU.
// #221: đơn và kiện (liệt kê, chi tiết, thuộc tính tách, tách, giao). #239: mã vận đơn của kiện (`package`). #227: yêu cầu trả, lần huỷ, lý do huỷ (chỉ đọc).
// #226, #219: kho, danh mục, thuộc tính, đẩy tồn, giá, tắt, bật, tải ảnh, tạo sản phẩm.
// Lệnh ghi (split, ship, push-*, deactivate, activate, create-product) chỉ dùng trên shop thử của nhóm (SANDBOX), đặt lại
// giá trị cũ sau khi thử. Mỗi lời gọi Open API in path, `code`, `request_id`.
// Token lưu ở .smoke-tokens.json (khoá `tiktok`, đã gitignore), không in ra đầy đủ.
// Cách chạy: scripts/smoke/README.md
import { randomUUID } from 'node:crypto';
import { MarketplaceError, type RemoteOrder, type RemoteOrderRef, type ShopConnection } from '../../src/modules/channel/channel/service/marketplaces/common.ts';
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

/** Mọi SKU của shop như bước ghép ở thiết lập thấy (#282): số sản phẩm, số SKU, toàn bộ danh sách. Chỉ đọc. */
async function products(shopId: string | undefined): Promise<void> {
  const saved = loadTokens<TiktokTokens>('tiktok');
  if (saved.accessExpiresAt && saved.accessExpiresAt * 1000 < Date.now()) console.log(`access token hết hạn từ ${iso(saved.accessExpiresAt)}, chạy "refresh" trước.`);
  const list = await adapter.listSkus!(packedFor(saved, shopId));
  printStep('listSkus (product/202502/products/search + product/202309/products/{id}, tối đa 50 sản phẩm, nhiều SKU trước)', true, {
    products: new Set(list.map((s) => s.externalProductId)).size,
    skus: list.length,
    items: list.map(({ externalProductId, externalSkuId, sellerSku, title, state, quantity, imageUrl }) => ({
      externalProductId,
      externalSkuId,
      sellerSku,
      title,
      state,
      quantity,
      imageUrl,
    })),
  });
}

/**
 * Hai con số lúc nối (`countRemote`, §18.7.4) và `total_count` của Search Products theo `status`, để thấy `ALL` có tính
 * sản phẩm `DELETED`. Chỉ đọc.
 */
async function counts(shopId: string | undefined): Promise<void> {
  const saved = loadTokens<TiktokTokens>('tiktok');
  if (saved.accessExpiresAt && saved.accessExpiresAt * 1000 < Date.now()) console.log(`access token hết hạn từ ${iso(saved.accessExpiresAt)}, chạy "refresh" trước.`);
  const packed = packedFor(saved, shopId);
  const totals: Record<string, unknown> = {};
  for (const status of ['ALL', 'DELETED']) {
    const data = await client.call<{ total_count?: unknown }>('POST', '/product/202502/products/search', { token: packed, query: { page_size: 1 }, body: { status } });
    totals[status] = data?.total_count;
  }
  printStep('countRemote (product/202502/products/search)', true, { total_count: totals, countRemote: await adapter.countRemote!(packed) });
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

/** Lý do từ chối (Get Decision Eligibility 202601) và lịch sử (Get Return Records 202309) của một yêu cầu trả (#392). Chỉ đọc. */
async function returnInfo(kind: 'reasons' | 'records', returnId: string | undefined, action: string | undefined): Promise<void> {
  if (!returnId) throw new Error(kind === 'reasons' ? 'Cú pháp: return-reasons <returnId> [reject|refuse-refund]' : 'Cú pháp: return-records <returnId>');
  const packed = packedFor(loadTokens<TiktokTokens>('tiktok'));
  if (kind === 'records') {
    printStep('returnHistory (return_refund/202309/returns/{id}/records)', true, await adapter.returnHistory!(packed, returnId, []));
    return;
  }
  const which = action === 'refuse-refund' ? 'refuse-refund' : 'reject';
  printStep('returnReasons ' + which + ' (return_refund/202601/decision_eligibility)', true, await adapter.returnReasons!(packed, returnId, which));
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
  const all = (await adapter.categoryTree!(session())).filter((c) => c.isLeaf && (c.permissionStatuses?.includes('AVAILABLE') ?? true));
  const q = keyword?.toLocaleLowerCase('vi');
  const hit = q ? all.filter((c) => c.path.toLocaleLowerCase('vi').includes(q)) : all;
  printStep('product/202309/categories (lá AVAILABLE)', true, { leaves: all.length, matched: hit.length, items: hit.slice(0, 15) });
}

async function attrs(categoryId: string | undefined): Promise<void> {
  if (!categoryId) throw new Error('Cú pháp: attrs <categoryId>');
  printStep('product/202309/categories/{id}/attributes (bắt buộc)', true, (await adapter.leafAttributes!(session(), categoryId)).filter((a) => a.required));
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

/**
 * Đổi category của một sản phẩm thử (`CM-TEST-`, #467) bằng `changeCategory` của adapter: in category trước, kết quả so SKU,
 * giá, ảnh, rồi đọc lại category (bản đang bán và bản đang duyệt). Thuộc tính truyền `mã=giá trị` như create-product.
 */
// #497: các trường dùng chung của một sản phẩm (Get Product 202309) để ghép SKU tự điền: in tên trường và giá trị rút gọn.
async function productFacts(productId: string | undefined): Promise<void> {
  if (!productId) throw new Error('Cú pháp: product <productId>');
  type Img = { urls?: string[] };
  type P = {
    title?: string;
    description?: string;
    brand?: { name?: string };
    main_images?: Img[];
    size_chart?: { image?: Img; template?: { id?: string } };
    package_weight?: unknown;
    package_dimensions?: unknown;
    product_attributes?: { id?: string; name?: string; values?: { id?: string; name?: string }[] }[];
    skus?: { id?: string; seller_sku?: string }[];
  };
  const p = await client.call<P>('GET', `/product/202309/products/${encodeURIComponent(productId)}`, { token: session() });
  printStep('product/202309/products/{id}', true, {
    title: p?.title,
    description: p?.description?.slice(0, 120),
    brand: p?.brand,
    mainImages: p?.main_images?.map((i) => i.urls?.[0]?.slice(0, 80)),
    sizeChart: { image: p?.size_chart?.image?.urls?.[0]?.slice(0, 80) ?? null, template: p?.size_chart?.template ?? null },
    packageWeight: p?.package_weight,
    packageDimensions: p?.package_dimensions,
    attributes: p?.product_attributes?.map((a) => `${a.id} ${a.name}: ${a.values?.map((v) => `${v.id}/${v.name}`).join(', ')}`),
    skus: p?.skus?.map((s) => `${s.id} ${s.seller_sku}`),
  });
}

async function changeCategory(productId: string | undefined, categoryId: string | undefined, rest: string[]): Promise<void> {
  if (!productId || !categoryId) throw new Error('Cú pháp: change-category <productId> <categoryId> [mãThuộcTính=giáTrị ...] [size-chart=<URL ảnh>]');
  const packed = session();
  const path = `/product/202309/products/${productId}`;
  type P = { title?: string; category_chains?: { id: string; is_leaf?: boolean }[]; status?: string; skus?: { seller_sku?: string; price?: unknown }[] };
  const before = await client.call<P>('GET', path, { token: packed });
  if (!before?.title?.startsWith('CM-TEST-')) throw new Error('Chỉ đổi category sản phẩm thử có tên bắt đầu CM-TEST-');
  const leaf = (p: P | undefined) => p?.category_chains?.find((c) => c.is_leaf)?.id;
  // `size-chart=<URL ảnh>`: truyền URL như việc nền; adapter tự đưa ảnh lên chỉ khi sản phẩm chưa có bảng size.
  const chart = rest.find((a) => a.startsWith('size-chart='))?.slice('size-chart='.length);
  const result = await adapter.changeCategory!(packed, productId, {
    externalCategoryId: categoryId,
    attributes: Object.fromEntries(rest.filter((a) => !a.startsWith('size-chart=')).map((a) => a.split('=') as [string, string])),
    ...(chart && { sizeChartUrl: chart }),
  });
  const live = await client.call<P>('GET', path, { token: packed });
  const review = await client.call<P>('GET', path, { token: packed, query: { return_under_review_version: 'true' } }).catch(() => undefined);
  printStep('changeCategory (Get Product → Edit Product 202509 → đọc lại)', result.mismatch.length === 0, {
    before: { category: leaf(before), status: before.status, skus: before.skus?.map((s) => [s.seller_sku, s.price]) },
    result,
    after: { category: leaf(live), status: live?.status, skus: live?.skus?.map((s) => [s.seller_sku, s.price]) },
    underReview: review ? { category: leaf(review), status: review.status } : null,
  });
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

/** Đơn đã chuẩn hoá, rút gọn để đọc: món kèm kiện, trạng thái gốc và trạng thái app. */
const brief = (o: RemoteOrder) => ({
  id: o.externalOrderId,
  rawStatus: o.rawStatus,
  paid: o.paid,
  isCod: o.isCod,
  placedAt: o.placedAt.toISOString(),
  updatedAt: o.updatedAt.toISOString(),
  shipBy: o.shipBy?.toISOString() ?? null,
  deliveredAt: o.deliveredAt?.toISOString() ?? null,
  cancelRequested: o.cancelRequested,
  shippingFee: o.shippingFee,
  address: o.shippingAddress && { ...o.shippingAddress, raw: undefined },
  lines: o.lines.map((l) => `${l.externalLineId} ${l.sellerSku} ${l.unitPrice} ${l.rawStatus}→${l.status} kiện ${l.packageCode} vận đơn ${l.trackingCode}`),
});


/** Lật hết `listOrders` (hoặc `listOpenOrders`) rồi lấy chi tiết theo lô. */
async function orders(open: boolean, days: number): Promise<void> {
  const packed = session();
  const refs: RemoteOrderRef[] = [];
  let cursor: string | null = null;
  let pages = 0;
  const safe: string[] = [];
  do {
    const prev: string | null = cursor;
    const page: { orders: RemoteOrderRef[]; nextCursor: string | null; safeUntil: Date | null } = open ? await adapter.listOpenOrders!(packed, prev) : await adapter.listOrders!(packed, new Date(Date.now() - days * 86_400_000), prev);
    refs.push(...page.orders);
    if (page.safeUntil) safe.push(page.safeUntil.toISOString());
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor && pages < 50);
  printStep(open ? 'listOpenOrders (order/202309/orders/search theo order_status)' : `listOrders ${days} ngày (order/202309/orders/search)`, true, {
    pages,
    count: refs.length,
    safeUntil: safe,
    refs: refs.map((r) => `${r.externalOrderId} cập nhật ${r.updatedAt.toISOString()}`),
  });
  if (!refs.length) return;
  const detail = await adapter.getOrders!(packed, refs);
  printStep('getOrders (order/202507/orders)', true, detail.map(brief));
}

async function order(id: string | undefined): Promise<void> {
  if (!id) throw new Error('Cú pháp: order <orderId>');
  printStep('getOrder (order/202507/orders)', true, brief(await adapter.getOrder!(session(), id)));
}

async function splitAttr(id: string | undefined): Promise<void> {
  if (!id) throw new Error('Cú pháp: split-attr <orderId>');
  printStep('splitAttributes (fulfillment/202309/orders/split_attributes)', true, await adapter.splitAttributes!(session(), id));
}

/** `split <orderId> <lineId,lineId> <lineId> ...`: mỗi nhóm một kiện mới. Ghi lên sàn, chỉ dùng với shop thử. */
async function split(id: string | undefined, groups: string[]): Promise<void> {
  if (!id || groups.length < 2) throw new Error('Cú pháp: split <orderId> <nhóm 1: lineId,lineId> <nhóm 2> ...');
  const packages = await adapter.splitOrder!(session(), id, groups.map((g) => g.split(',')));
  printStep('splitOrder (fulfillment/202309/orders/{order_id}/split)', true, { packages });
}

/** `ship <packageId> [pickup|drop_off]`. Ghi lên sàn, chỉ dùng với shop thử. */
async function ship(packageId: string | undefined, handover: string | undefined): Promise<void> {
  if (!packageId) throw new Error('Cú pháp: ship <packageId> [pickup|drop_off]');
  const opts = handover === 'pickup' || handover === 'drop_off' ? { handover: handover as 'pickup' | 'drop_off' } : undefined;
  await adapter.shipPackage!(session(), packageId, opts);
  printStep('shipPackage (fulfillment/202309/packages/{package_id}/ship)', true, { packageId });
}

/**
 * `package <packageId>` (#239 KH-B02, chỉ đọc): mã vận đơn sau Ship Package. In phản hồi gốc của Get Package Detail để
 * so `shipping_info`, `tracking_number`, rồi kết quả `packageTracking` của adapter.
 */
async function packageDetail(packageId: string | undefined): Promise<void> {
  if (!packageId) throw new Error('Cú pháp: package <packageId>');
  const packed = session();
  const raw = await client.call('GET', `/fulfillment/202309/packages/${encodeURIComponent(packageId)}`, { token: packed });
  console.log(JSON.stringify(raw, null, 2));
  printStep('packageTracking (fulfillment/202309/packages/{package_id})', true, { packageId, trackingCode: await adapter.packageTracking!(packed, packageId) });
}

const [command, ...args] = process.argv.slice(2);
const commands: Record<string, () => Promise<void> | void> = {
  link,
  token: () => token(args[0]),
  shops,
  refresh,
  // skus [shopId] [sellerSku ...]
  skus: () => skus(args[0] && /^\d+$/.test(args[0]) ? args[0] : undefined, args.filter((a, i) => !(i === 0 && /^\d+$/.test(a)))),
  // products [shopId]: mọi SKU như bước ghép ở thiết lập (#282, chỉ đọc)
  counts: () => {
    if (args[0] !== undefined && !/^\d+$/.test(args[0])) throw new Error('shopId là mã shop TikTok, chỉ gồm chữ số');
    return counts(args[0]);
  },
  products: () => {
    if (args[0] !== undefined && !/^\d+$/.test(args[0])) throw new Error('shopId là mã shop TikTok, chỉ gồm chữ số');
    return products(args[0]);
  },
  // returns [số ngày], cancellations [số ngày], cancel-reasons <orderId> (#227, chỉ đọc)
  returns: () => aftersales('returns', args[0]),
  cancellations: () => aftersales('cancellations', args[0]),
  'cancel-reasons': () => cancelReasons(args[0]),
  // return-reasons <returnId> [reject|refuse-refund], return-records <returnId> (#392, chỉ đọc)
  'return-reasons': () => returnInfo('reasons', args[0], args[1]),
  'return-records': () => returnInfo('records', args[0], undefined),
  warehouses,
  categories: () => categories(args[0]),
  attrs: () => attrs(args[0]),
  'push-stock': () => pushStock(args[0], args[1]),
  'push-price': () => pushPrice(args[0], args[1]),
  deactivate: () => toggle('deactivate', args[0]),
  activate: () => toggle('activate', args[0]),
  'upload-image': () => uploadImage(args[0]),
  'create-product': () => createProduct(args[0], args[1], args.slice(2)),
  'change-category': () => changeCategory(args[0], args[1], args.slice(2)),
  product: () => productFacts(args[0]),
  // orders [số ngày, mặc định 30] | open-orders | order <id> | split-attr <id> | split <id> <nhóm> <nhóm> | ship <kiện> [cách]
  // | package <kiện> (chỉ đọc)
  orders: () => orders(false, Number(args[0] ?? 30)),
  'open-orders': () => orders(true, 0),
  order: () => order(args[0]),
  'split-attr': () => splitAttr(args[0]),
  split: () => split(args[0], args.slice(1)),
  ship: () => ship(args[0], args[1]),
  package: () => packageDetail(args[0]),
};
const run = command ? commands[command] : undefined;
if (!run) {
  console.log(
    'Lệnh: link | token <URL callback | code> | shops | refresh | products [shopId] | skus [shopId] [sellerSku ...] | warehouses | categories [từ khoá] |\n' +
      '  attrs <categoryId> | push-stock <sellerSku> <qty> | push-price <sellerSku> <giá> | deactivate <sellerSku> | activate <sellerSku> |\n' +
      '  upload-image <URL ảnh> | create-product <categoryId> <URL ảnh> [mãThuộcTính=giáTrị ...] |\n' +
      '  returns [ngày] | cancellations [ngày] | cancel-reasons <orderId> |\n' +
      '  return-reasons <returnId> [reject|refuse-refund] | return-records <returnId> |\n' +
      '  orders [ngày] | open-orders | order <id> | split-attr <id> | split <id> <nhóm> <nhóm> | ship <kiện> [pickup|drop_off] | package <kiện>',
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
