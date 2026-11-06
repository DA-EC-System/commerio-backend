// Smoke test TikTok Shop bằng chính adapter của app (#217): link uỷ quyền, đổi code, đọc gian hàng, làm mới, đọc SKU.
// Chỉ gọi API đọc và API token. Token lưu ở .smoke-tokens.json (khoá `tiktok`, đã gitignore), không in ra đầy đủ.
// Cách chạy: scripts/smoke/README.md
import { randomUUID } from 'node:crypto';
import { MarketplaceError, type ShopConnection } from '../../src/modules/channel/channel/service/marketplaces/common.ts';
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

const [command, ...args] = process.argv.slice(2);
const commands: Record<string, () => Promise<void> | void> = {
  link,
  token: () => token(args[0]),
  shops,
  refresh,
  // skus [shopId] [sellerSku ...]
  skus: () => skus(args[0] && /^\d+$/.test(args[0]) ? args[0] : undefined, args.filter((a, i) => !(i === 0 && /^\d+$/.test(a)))),
};
const run = command ? commands[command] : undefined;
if (!run) {
  console.log('Lệnh: link | token <URL callback | code> | shops | refresh | skus [shopId] [sellerSku ...]');
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
