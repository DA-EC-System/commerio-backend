// Smoke test TikTok Shop bằng chính adapter của app (#217): link uỷ quyền, đổi code, đọc gian hàng, làm mới, đọc SKU;
// đơn và kiện (#221): liệt kê, chi tiết, thuộc tính tách. Chỉ gọi API đọc và API token, trừ `split`, `ship` (ghi, chỉ
// dùng trên shop thử sandbox). Token lưu ở .smoke-tokens.json (khoá `tiktok`, đã gitignore), không in ra đầy đủ.
// Cách chạy: scripts/smoke/README.md
import { randomUUID } from 'node:crypto';
import { MarketplaceError, type RemoteOrder, type RemoteOrderRef, type ShopConnection } from '../../src/modules/channel/channel/service/marketplaces/common.ts';
import { packTiktokToken, unpackTiktokToken } from '../../src/modules/channel/channel/service/marketplaces/tiktok-client.ts';
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

const adapter = createTiktokAdapter({
  appKey: requireEnv('TIKTOK_APP_KEY'),
  appSecret: requireEnv('TIKTOK_APP_SECRET'),
  serviceId: process.env.TIKTOK_SERVICE_ID,
  apiUrl: process.env.TIKTOK_API_URL ?? 'https://open-api.tiktokglobalshop.com',
  authUrl: process.env.TIKTOK_AUTH_URL ?? 'https://auth.tiktok-shops.com',
});

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

function session(): string {
  const saved = loadTokens<TiktokTokens>('tiktok');
  if (saved.accessExpiresAt && saved.accessExpiresAt * 1000 < Date.now()) console.log(`access token hết hạn từ ${iso(saved.accessExpiresAt)}, chạy "refresh" trước.`);
  return packedFor(saved);
}

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

const [command, ...args] = process.argv.slice(2);
const commands: Record<string, () => Promise<void> | void> = {
  link,
  token: () => token(args[0]),
  shops,
  refresh,
  // skus [shopId] [sellerSku ...]
  skus: () => skus(args[0] && /^\d+$/.test(args[0]) ? args[0] : undefined, args.filter((a, i) => !(i === 0 && /^\d+$/.test(a)))),
  // orders [số ngày, mặc định 30] | open-orders | order <id> | split-attr <id> | split <id> <nhóm> <nhóm> | ship <kiện> [cách]
  orders: () => orders(false, Number(args[0] ?? 30)),
  'open-orders': () => orders(true, 0),
  order: () => order(args[0]),
  'split-attr': () => splitAttr(args[0]),
  split: () => split(args[0], args.slice(1)),
  ship: () => ship(args[0], args[1]),
};
const run = command ? commands[command] : undefined;
if (!run) {
  console.log(
    'Lệnh: link | token <URL callback | code> | shops | refresh | skus [shopId] [sellerSku ...] | orders [ngày] | open-orders | order <id> | split-attr <id> | split <id> <nhóm> <nhóm> | ship <kiện> [pickup|drop_off]',
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
