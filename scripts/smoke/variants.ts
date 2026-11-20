// Smoke gom biến thể (#295, Documents/21 §18.8.4) trên shop thử: tạo sản phẩm nhiều SKU, thêm phân loại, gỡ phân loại, qua
// đúng adapter của app. Chỉ dùng shop thử SANDBOX; in path, mã, request_id của mỗi lời gọi, không in token.
//   npm run smoke:variants -- <lazada|tiktok> create <categoryId> <URL ảnh> <mãTrục|-> <giáTrị1,giáTrị2> [mã=giáTrị ...]
//   npm run smoke:variants -- <lazada|tiktok> add <productId> <categoryId> <URL ảnh> <mãTrục|-> <giáTrị> [mã=giáTrị ...]
//   npm run smoke:variants -- <lazada|tiktok> remove <productId> <skuId>
// `mãTrục` là mã sale prop của leaf (Lazada bắt buộc, vd `color_family`); `-` là trục tự đặt tên "Màu" (TikTok).
// Token: TikTok đọc `.smoke-tokens.json` (`npm run smoke:tiktok -- token <URL>`), Lazada đọc `LAZADA_ACCESS_TOKEN` hoặc
// `.smoke-tokens.json` (`npm run smoke:lazada -- token <code>`).
import type { MarketplaceAdapter, NewProduct, ProductSku } from '../../src/modules/channel/channel/service/marketplaces/common.ts';
import { createLazadaAdapter } from '../../src/modules/channel/channel/service/marketplaces/lazada.ts';
import { packTiktokToken } from '../../src/modules/channel/channel/service/marketplaces/tiktok-client.ts';
import { createTiktokAdapter } from '../../src/modules/channel/channel/service/marketplaces/tiktok.ts';
import { loadTokens, printStep, requireEnv } from './token-store.ts';

const [platform, command, ...args] = process.argv.slice(2);

/** In path, mã, request_id của mỗi lời gọi tới sàn (không in query ký, token). */
const loggingFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  const url = new URL(String(input));
  const body = (await res
    .clone()
    .json()
    .catch(() => ({}))) as { code?: unknown; message?: unknown; request_id?: unknown };
  const msg = body.message && String(body.code) !== '0' ? ` message=${String(body.message)}` : '';
  console.log(`  ${init?.method ?? 'GET'} ${url.pathname} → HTTP ${res.status} code=${String(body.code)} request_id=${String(body.request_id)}${msg}`);
  return res;
};

function lazada(): { adapter: MarketplaceAdapter; token: string } {
  const adapter = createLazadaAdapter(
    {
      appKey: requireEnv('LAZADA_APP_KEY'),
      appSecret: requireEnv('LAZADA_APP_SECRET'),
      redirectUrl: process.env.LAZADA_REDIRECT_URL,
      apiUrl: process.env.LAZADA_API_URL ?? 'https://api.lazada.vn/rest',
      authUrl: process.env.LAZADA_AUTH_URL ?? 'https://auth.lazada.com/rest',
    },
    loggingFetch,
  );
  const token = process.env.LAZADA_ACCESS_TOKEN || loadTokens<{ accessToken: string }>('lazada').accessToken;
  return { adapter, token };
}

function tiktok(): { adapter: MarketplaceAdapter; token: string } {
  const config = {
    appKey: requireEnv('TIKTOK_APP_KEY'),
    appSecret: requireEnv('TIKTOK_APP_SECRET'),
    serviceId: process.env.TIKTOK_SERVICE_ID,
    apiUrl: process.env.TIKTOK_API_URL ?? 'https://open-api.tiktokglobalshop.com',
    authUrl: process.env.TIKTOK_AUTH_URL ?? 'https://auth.tiktok-shops.com',
  };
  const saved = loadTokens<{ accessToken: string; shops: { id: string; cipher: string }[] }>('tiktok');
  const shop = saved.shops[0];
  if (!shop) throw new Error('Chưa có gian hàng TikTok trong .smoke-tokens.json');
  return { adapter: createTiktokAdapter(config, loggingFetch), token: packTiktokToken({ token: saved.accessToken, cipher: shop.cipher, shopId: shop.id }) };
}

const stamp = new Date().toISOString().replace(/\D/g, '').slice(2, 12);
const sku = (label: string, i: number): ProductSku => ({
  sellerSku: `CM-GOM-${stamp}-${i}`,
  price: String(99000 + i * 1000),
  quantity: 5,
  values: [label],
  weightG: 300,
  lengthMm: 100,
  widthMm: 100,
  heightMm: 100,
});

/** Sản phẩm thử một trục, các giá trị theo thứ tự; tiêu đề là tên cha (§18.8.4), đủ 25 ký tự cho TikTok. */
async function product(adapter: MarketplaceAdapter, token: string, a: string[], offset: number): Promise<NewProduct> {
  const [categoryId, imageUrl, axis, values, ...attrs] = a;
  if (!categoryId || !imageUrl || !axis || !values) throw new Error('Thiếu tham số, xem đầu file');
  const labels = values.split(',');
  const skus = labels.map((l, i) => sku(l, offset + i));
  const uri = await adapter.uploadImage(token, imageUrl);
  return {
    externalCategoryId: categoryId,
    attributes: Object.fromEntries(attrs.map((x) => x.split('=') as [string, string])),
    name: `CM-GOM-${stamp} Sản phẩm thử gom biến thể Commerio, không bán`,
    description: 'Sản phẩm thử của đồ án Commerio, tạo bằng API để kiểm gom biến thể. Không bán.',
    imageUrls: [uri],
    ...skus[0]!,
    salesAttributes: [{ code: axis === '-' ? null : axis, name: 'Màu', values: labels.map((label) => ({ optionId: null, label })) }],
    skus,
  };
}

const pick = platform === 'lazada' ? lazada : platform === 'tiktok' ? tiktok : null;
const commands: Record<string, () => Promise<void>> = {
  async create() {
    const { adapter, token } = pick!();
    const p = await product(adapter, token, args, 1);
    printStep('createProduct nhiều SKU', true, await adapter.createProduct(token, { ...p, idempotencyKey: `cm-gom-${stamp}` }));
  },
  async add() {
    const { adapter, token } = pick!();
    const [productId, ...rest] = args;
    if (!productId || !adapter.addVariants) throw new Error('Cú pháp: add <productId> … (adapter phải có addVariants)');
    const p = await product(adapter, token, rest, 9);
    printStep('addVariants', true, await adapter.addVariants(token, productId, { ...p, skus: p.skus! }));
  },
  async remove() {
    const { adapter, token } = pick!();
    const [productId, skuId] = args;
    if (!productId || !skuId || !adapter.removeVariants) throw new Error('Cú pháp: remove <productId> <skuId>');
    await adapter.removeVariants(token, productId, [skuId]);
    printStep('removeVariants', true, { productId, skuId });
  },
};
const run = pick && command ? commands[command] : undefined;
if (!run) {
  console.log('Lệnh: <lazada|tiktok> create | add | remove (xem đầu file)');
  process.exitCode = 1;
} else {
  await run().catch((err: unknown) => {
    console.error(err instanceof Error ? `${err.name}: ${err.message} ${JSON.stringify(err)}` : err);
    process.exitCode = 1;
  });
}
