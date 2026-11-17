// Ẩn, hiện listing TikTok theo trạng thái SKU (#224 phần 2; 25 §6.4 "Sàn không ẩn riêng được một phân loại"; 21 §18.3).
// TikTok tắt, bật theo cả sản phẩm: listing app ẩn luôn để tồn 0 trên sàn; mọi listing của sản phẩm đều ẩn thì tắt sản
// phẩm; hiện lại khi sản phẩm đang tắt thì bật sản phẩm (sàn duyệt lại).
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PerSkuResult, PriceQuantity, RemoteSku } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { syncListings } from '#src/modules/channel/channel/service/listing-sync.ts';
import { runStockPush } from '#src/modules/channel/channel/service/background.ts';
import { onVariantStatusChanged } from '#src/modules/channel/channel/service/variant-status.ts';
import { productPort, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { createModuleContext } from '#src/wiring.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { activateShop, FAKE_CAPABILITIES, fakeAdapter } from './helpers.ts';

setProductPort(null);
const calls: string[] = [];
let failZeroFor: string | null = null;
const updatePriceQuantity = vi.fn(async (_t: string, items: readonly PriceQuantity[]) => {
  for (const i of items) calls.push(`qty:${i.externalSkuId}:${i.quantity ?? '-'}:${i.price ?? '-'}`);
  return items.map((i): PerSkuResult => {
    if (i.externalSkuId === failZeroFor) return { externalSkuId: i.externalSkuId, ok: false, code: 'x', message: 'sàn lỗi' };
    return { externalSkuId: i.externalSkuId, ok: true };
  });
});
const deactivate = vi.fn(async (_t: string, p: string, _s: string) => {
  calls.push(`deactivate:${p}`);
  state.set(p, 'inactive');
});
const activate = vi.fn(async (_t: string, p: string, _s: string) => {
  calls.push(`activate:${p}`);
  state.set(p, 'review');
});
/** Trạng thái sản phẩm trên sàn giả, theo mã sản phẩm (TikTok tắt, bật cả sản phẩm). */
const state = new Map<string, RemoteSku['state']>();
const skus = new Map<string, string>(); // sellerSku → externalProductId
const getSkus = vi.fn(async (_t: string, sellerSkus: readonly string[]) =>
  sellerSkus.flatMap((sku): RemoteSku[] => {
    const product = skus.get(sku);
    if (!product) return [];
    return [
      { externalProductId: product, externalSkuId: `sku-${sku}`, sellerSku: sku, title: 'x', state: state.get(product) ?? 'live', rejectReason: null, quantity: 0, sellableQuantity: 0 },
    ];
  }),
);
const seller = async (accessToken: string) => ({ externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' });
registerAdapter('tiktok', fakeAdapter({ getSeller: seller, getSkus, updatePriceQuantity, deactivate, activate, togglesByProduct: true, capabilities: { ...FAKE_CAPABILITIES, hideBy: 'zero_stock' } }));
afterAll(() => resetAdapters());

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
let shopId = '';
const port = () => productPort(createModuleContext());

/** Sản phẩm TikTok có `n` listing `live` (mỗi listing một SKU), tồn đã đồng bộ. */
async function seedProduct(n: number) {
  const product = `item-${randomUUID().slice(0, 8)}`;
  const out: { variantId: string; sku: string; listingId: string }[] = [];
  for (let i = 0; i < n; i++) {
    const { variantId, sku } = await createVariant(company.companyId);
    await receive(company.companyId, variantId, 5, 1000);
    skus.set(sku, product);
    const { rows } = await testPool().query(
      `insert into channel.listings (company_id, shop_id, variant_id, external_product_id, external_sku_id, seller_sku, status,
         stock_sync, price_sync, platform_stock)
       values ($1, $2, $3, $4, $5, $6, 'live', 'synced', 'synced', 5) returning id`,
      [company.companyId, shopId, variantId, product, `sku-${sku}`, sku],
    );
    out.push({ variantId, sku, listingId: rows[0].id as string });
  }
  return { product, items: out };
}
async function addUnmanaged(product: string) {
  const sku = `COMBO-${randomUUID().slice(0, 6)}`;
  skus.set(sku, product);
  await testPool().query(
    `insert into channel.listings (company_id, shop_id, mode, external_product_id, external_sku_id, seller_sku, status, approved_by)
     values ($1, $2, 'unmanaged', $3, $4, $5, 'live', $6)`,
    [company.companyId, shopId, product, `sku-${sku}`, sku, randomUUID()],
  );
}
const setStatus = (variantId: string, status: string) =>
  testPool().query('update product.product_variants set business_status = $2 where id = $1', [variantId, status]);
async function changeStatus(variantId: string, from: string, to: string) {
  await setStatus(variantId, to);
  await withCompany(company.companyId, () =>
    onVariantStatusChanged({ variantId, productId: randomUUID(), from, to, changedAt: new Date().toISOString() } as never),
  );
}
const runPush = () => runStockPush(port(), { companyId: company.companyId, shopId });
const sync = () => syncListings(port(), company.companyId, shopId);
async function listing(id: string) {
  return (await testPool().query('select * from channel.listings where id = $1', [id])).rows[0];
}

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  const res = await app()
    .post('/api/v1/channel/shops/tiktok/token')
    .set('Authorization', `Bearer ${company.ceo.token}`)
    .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  shopId = res.body.shop.id;
  await activateShop(shopId);
});
beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  failZeroFor = null;
});

describe('TikTok: ẩn theo SKU bằng tồn 0, tắt cả sản phẩm khi mọi SKU đều ẩn', () => {
  it('P2-1: sản phẩm 2 SKU, tạm ngừng A → không tắt sản phẩm, A hidden zero_stock, sàn nhận tồn 0 cho A', async () => {
    const { product, items } = await seedProduct(2);
    const [a] = items;
    await changeStatus(a!.variantId, 'selling', 'paused');
    await runPush();
    expect(deactivate).not.toHaveBeenCalled();
    expect(await listing(a!.listingId)).toMatchObject({ status: 'hidden', hidden_by: 'zero_stock', platform_stock: 0, stock_sync: 'synced' });
    expect(calls).toContain(`qty:sku-${a!.sku}:0:-`);
    expect(state.get(product)).toBeUndefined();
  });

  it('P2-2: tạm ngừng tiếp B → tắt sản phẩm một lần; cả hai vẫn zero_stock (tồn 0 trên sàn)', async () => {
    const { product, items } = await seedProduct(2);
    const [a, b] = items;
    await changeStatus(a!.variantId, 'selling', 'paused');
    await runPush();
    await changeStatus(b!.variantId, 'selling', 'paused');
    await runPush();
    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(deactivate).toHaveBeenCalledWith(expect.any(String), product, expect.any(String));
    for (const x of [a, b]) expect(await listing(x!.listingId)).toMatchObject({ status: 'hidden', hidden_by: 'zero_stock' });
  });

  it('sản phẩm đã tắt trên sàn, lượt đồng bộ ẩn mọi SKU tạm ngừng → không gọi tắt lại', async () => {
    const { product, items } = await seedProduct(2);
    state.set(product, 'inactive');
    for (const x of items) await setStatus(x.variantId, 'paused');
    await sync();
    for (const x of items) expect(await listing(x.listingId)).toMatchObject({ status: 'hidden', hidden_by: 'zero_stock' });
    expect(deactivate).not.toHaveBeenCalled();
  });

  it('P2-8: tạm ngừng hai SKU trong cùng một lượt → sản phẩm bị tắt', async () => {
    const { product, items } = await seedProduct(2);
    for (const x of items) await setStatus(x.variantId, 'paused');
    await runPush();
    expect(deactivate).toHaveBeenCalledWith(expect.any(String), product, expect.any(String));
    for (const x of items) expect(await listing(x.listingId)).toMatchObject({ status: 'hidden', hidden_by: 'zero_stock' });
  });

  it('P2-9: sản phẩm còn listing ghép không quản tồn đang bán → không tắt sản phẩm', async () => {
    const { product, items } = await seedProduct(1);
    await addUnmanaged(product);
    await changeStatus(items[0]!.variantId, 'selling', 'paused');
    await runPush();
    expect(deactivate).not.toHaveBeenCalled();
    expect(await listing(items[0]!.listingId)).toMatchObject({ status: 'hidden', hidden_by: 'zero_stock' });
  });

  it('P2-3: sản phẩm đang tắt, bỏ tạm ngừng A (B còn tạm ngừng, đã tồn 0) → bật sản phẩm; A live, B vẫn hidden zero_stock', async () => {
    const { product, items } = await seedProduct(2);
    const [a, b] = items;
    for (const x of items) await setStatus(x.variantId, 'paused');
    await runPush();
    expect(state.get(product)).toBe('inactive');
    vi.clearAllMocks();
    calls.length = 0;
    await changeStatus(a!.variantId, 'paused', 'selling');
    await runPush();
    expect(activate).toHaveBeenCalledTimes(1);
    expect(await listing(a!.listingId)).toMatchObject({ status: 'live', hidden_by: null });
    expect(await listing(b!.listingId)).toMatchObject({ status: 'hidden', hidden_by: 'zero_stock', platform_stock: 0 });
    expect(calls).toContain(`qty:sku-${a!.sku}:5:-`);
    expect(calls).not.toContain(`qty:sku-${b!.sku}:5:-`);
  });

  it('P2-5: SKU còn ẩn chưa có tồn 0 trên sàn → chưa bật sản phẩm, A vẫn hidden; đẩy 0 xong thì lượt sau bật', async () => {
    const { product, items } = await seedProduct(2);
    const [a, b] = items;
    for (const x of items) await setStatus(x.variantId, 'paused');
    failZeroFor = `sku-${b!.sku}`;
    await runPush();
    expect(state.get(product)).toBe('inactive');
    expect(await listing(b!.listingId)).toMatchObject({ status: 'hidden', stock_sync: 'pending' });
    await changeStatus(a!.variantId, 'paused', 'selling');
    await runPush();
    expect(activate).not.toHaveBeenCalled();
    expect(await listing(a!.listingId)).toMatchObject({ status: 'hidden' });
    failZeroFor = null;
    await runPush();
    await runPush();
    expect(activate).toHaveBeenCalledTimes(1);
    expect(await listing(a!.listingId)).toMatchObject({ status: 'live' });
  });

  it('review: listing chờ CEO quyết (người bán tắt) mà người bán tự bật lại trên sàn → lượt đồng bộ không tắt lại sản phẩm', async () => {
    const { product, items } = await seedProduct(1);
    await testPool().query(
      `update channel.listings set status = 'hidden', hidden_by = 'platform', outside_change_kind = 'disabled', outside_change_at = now()
       where id = $1`,
      [items[0]!.listingId],
    );
    state.set(product, 'live');
    await sync();
    expect(deactivate).not.toHaveBeenCalled();
    expect(await listing(items[0]!.listingId)).toMatchObject({ status: 'hidden', outside_change_kind: 'disabled' });
  });

  it('review: sản phẩm đang tắt, bỏ tạm ngừng A cùng lượt B vừa tạm ngừng (B còn live, chưa tồn 0) → chưa bật; lượt sau B đã tồn 0 thì bật', async () => {
    const { product, items } = await seedProduct(2);
    const [a, b] = items;
    await changeStatus(a!.variantId, 'selling', 'paused');
    await runPush();
    state.set(product, 'inactive');
    await setStatus(b!.variantId, 'paused');
    await changeStatus(a!.variantId, 'paused', 'selling');
    await runPush();
    expect(activate).not.toHaveBeenCalled();
    expect(await listing(a!.listingId)).toMatchObject({ status: 'hidden' });
    expect(await listing(b!.listingId)).toMatchObject({ status: 'hidden', hidden_by: 'zero_stock', platform_stock: 0 });
    await runPush();
    expect(activate).toHaveBeenCalledTimes(1);
    expect(await listing(a!.listingId)).toMatchObject({ status: 'live' });
  });

  it('P2-4: sản phẩm một SKU: tạm ngừng → tắt sản phẩm; bỏ tạm ngừng → bật, live, đẩy lại tồn', async () => {
    const { product, items } = await seedProduct(1);
    const [a] = items;
    await changeStatus(a!.variantId, 'selling', 'paused');
    await runPush();
    expect(deactivate).toHaveBeenCalledWith(expect.any(String), product, `sku-${a!.sku}`);
    await changeStatus(a!.variantId, 'paused', 'selling');
    await runPush();
    expect(activate).toHaveBeenCalledWith(expect.any(String), product, `sku-${a!.sku}`);
    expect(await listing(a!.listingId)).toMatchObject({ status: 'live', hidden_by: null, platform_stock: 5 });
  });

  it('P2-6, P2-10: lượt đồng bộ sau khi app tắt sản phẩm: không outside_hold, không bật Lệch tồn, không đẩy giá cho listing ẩn', async () => {
    const { items } = await seedProduct(2);
    for (const x of items) await setStatus(x.variantId, 'paused');
    await runPush();
    await testPool().query("update channel.listings set price_sync = 'pending' where id = $1", [items[0]!.listingId]);
    calls.length = 0;
    await sync();
    await sync();
    for (const x of items) {
      expect(await listing(x.listingId)).toMatchObject({ status: 'hidden', outside_change_kind: null });
      expect((await listing(x.listingId)).stock_sync).not.toBe('error');
    }
    expect(calls.filter((c) => !c.endsWith(':-'))).toEqual([]);
    expect(await listing(items[0]!.listingId)).toMatchObject({ price_sync: 'pending' });
  });

  it('P2-11: sản phẩm có listing chờ CEO quyết (người bán tắt ngoài app) → bỏ tạm ngừng không bật sản phẩm', async () => {
    const { product, items } = await seedProduct(2);
    const [a, b] = items;
    await changeStatus(a!.variantId, 'selling', 'paused');
    await runPush();
    state.set(product, 'inactive');
    await sync();
    expect(await listing(b!.listingId)).toMatchObject({ status: 'hidden', outside_change_kind: 'disabled' });
    await changeStatus(a!.variantId, 'paused', 'selling');
    await runPush();
    expect(activate).not.toHaveBeenCalled();
    expect(await listing(a!.listingId)).toMatchObject({ status: 'hidden' });
  });
});
