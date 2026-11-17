// Ẩn, hiện listing theo trạng thái SKU (#224; 25 §6.4, E25; 21 §18.3; US-GH-10, ca C2-13, C2-14). Sự kiện
// `catalog.variant_status_changed` chưa có nơi phát (#204 PR 2) nên gọi thẳng handler với payload 21 §11.2.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PerSkuResult, PriceQuantity, RemoteSku } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { MarketplaceError } from '#src/modules/channel/channel/service/marketplaces/common.ts';
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
const updatePriceQuantity = vi.fn(async (_t: string, items: readonly PriceQuantity[]) =>
  items.map((i): PerSkuResult => ({ externalSkuId: i.externalSkuId, ok: true })),
);
const deactivate = vi.fn(async (_t: string, _p: string, _s: string) => {});
const activate = vi.fn(async (_t: string, _p: string, _s: string) => {});
let remote: RemoteSku[] = [];
const getSkus = vi.fn(async () => remote);
const seller = async (accessToken: string) => ({ externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' });
registerAdapter('lazada', fakeAdapter({ getSeller: seller, getSkus, updatePriceQuantity, deactivate, activate }));
// Sàn không ẩn riêng phân loại (21 §18.3: Shopee) → ẩn bằng tồn 0.
registerAdapter(
  'shopee',
  fakeAdapter({ getSeller: seller, getSkus, updatePriceQuantity, deactivate, activate, capabilities: { ...FAKE_CAPABILITIES, hideBy: 'zero_stock' } }),
);
afterAll(() => resetAdapters());

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
const shops: Record<'lazada' | 'shopee', string> = { lazada: '', shopee: '' };
const port = () => productPort(createModuleContext());

async function connect(platform: 'lazada' | 'shopee') {
  const res = await app()
    .post(`/api/v1/channel/shops/${platform}/token`)
    .set('Authorization', `Bearer ${company.ceo.token}`)
    .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  await activateShop(res.body.shop.id);
  return res.body.shop.id as string;
}

/** Listing đã trên sàn, tồn đã đồng bộ; ghi thẳng vì luồng đẩy có test riêng. */
async function seed(shopId: string, status: 'live' | 'under_review' | 'hidden' = 'live') {
  const { variantId, sku } = await createVariant(company.companyId);
  await receive(company.companyId, variantId, 5, 1000);
  const { rows } = await testPool().query(
    `insert into channel.listings (company_id, shop_id, variant_id, external_product_id, external_sku_id, seller_sku, status,
       stock_sync, price_sync, platform_stock, hidden_by)
     values ($1, $2, $3, $4, $5, $6, $7, 'synced', 'synced', 5, $8) returning id`,
    [company.companyId, shopId, variantId, `item-${sku}`, `sku-${sku}`, sku, status, status === 'hidden' ? 'platform' : null],
  );
  return { variantId, sku, listingId: rows[0].id as string };
}
const setStatus = (variantId: string, status: string) =>
  testPool().query('update product.product_variants set business_status = $2 where id = $1', [variantId, status]);
async function changeStatus(variantId: string, from: string, to: string) {
  await setStatus(variantId, to);
  await withCompany(company.companyId, () =>
    onVariantStatusChanged({ variantId, productId: randomUUID(), from, to, changedAt: new Date().toISOString() } as never),
  );
}
async function pushJobs(shopId: string) {
  const { rows } = await testPool().query("select data from pgboss.job where name = 'channel.stock_push' and data->>'shopId' = $1", [shopId]);
  return rows.map((r) => r.data);
}
const clearJobs = (shopId: string) => testPool().query("delete from pgboss.job where name = 'channel.stock_push' and data->>'shopId' = $1", [shopId]);
const runPush = (shopId: string) => runStockPush(port(), { companyId: company.companyId, shopId });
async function listing(id: string) {
  return (await testPool().query('select * from channel.listings where id = $1', [id])).rows[0];
}
async function lastTransition(id: string) {
  const { rows } = await testPool().query(
    "select action, from_state, to_state, actor_id from core.state_transitions where entity_type = 'listings' and entity_id = $1 order by id desc limit 1",
    [id],
  );
  return rows[0];
}
const sent = () => updatePriceQuantity.mock.calls.flatMap(([, items]) => items);

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  shops.lazada = await connect('lazada');
  shops.shopee = await connect('shopee');
});
beforeEach(() => {
  vi.clearAllMocks();
  remote = [];
});

describe('gian hàng hideBy = deactivate (Lazada)', () => {
  it('C2-13: SKU sang tạm ngừng → xếp stock_push; việc chạy thì tắt trên sàn, listing hidden, hidden_by platform, hệ thống ghi hide', async () => {
    const { variantId, sku, listingId } = await seed(shops.lazada);
    await clearJobs(shops.lazada);
    await changeStatus(variantId, 'selling', 'paused');
    expect(await pushJobs(shops.lazada)).toEqual([{ companyId: company.companyId, shopId: shops.lazada }]);

    await runPush(shops.lazada);
    expect(deactivate).toHaveBeenCalledWith(expect.any(String), `item-${sku}`, `sku-${sku}`);
    expect(await listing(listingId)).toMatchObject({ status: 'hidden', hidden_by: 'platform' });
    expect(await lastTransition(listingId)).toMatchObject({ action: 'hide', from_state: 'live', to_state: 'hidden', actor_id: null });
  });

  it('C2-14: bỏ tạm ngừng (sang selling hoặc discontinued) → bật lại trên sàn, listing live, hidden_by null, đẩy lại số có thể bán', async () => {
    for (const to of ['selling', 'discontinued']) {
      const { variantId, sku, listingId } = await seed(shops.lazada);
      await changeStatus(variantId, 'selling', 'paused');
      await runPush(shops.lazada);
      vi.clearAllMocks();

      await changeStatus(variantId, 'paused', to);
      await runPush(shops.lazada);
      expect(activate).toHaveBeenCalledWith(expect.any(String), `item-${sku}`, `sku-${sku}`);
      expect(sent().find((i) => i.externalSkuId === `sku-${sku}`)).toMatchObject({ quantity: 5 });
      expect(await listing(listingId)).toMatchObject({ status: 'live', hidden_by: null, stock_sync: 'synced' });
      expect(await lastTransition(listingId)).toMatchObject({ action: 'unhide', actor_id: null });
    }
  });

  it('app ẩn rồi có lịch sử hidden → hidden (CEO từ chối ghép) → bỏ tạm ngừng vẫn hiện lại', async () => {
    const { variantId, listingId } = await seed(shops.lazada);
    await changeStatus(variantId, 'selling', 'paused');
    await runPush(shops.lazada);
    await testPool().query(
      "insert into core.state_transitions (company_id, entity_type, entity_id, from_state, to_state, action, source) values ($1, 'listings', $2, 'hidden', 'hidden', 'reject_mapping', 'user')",
      [company.companyId, listingId],
    );
    await changeStatus(variantId, 'paused', 'selling');
    await runPush(shops.lazada);
    expect(await listing(listingId)).toMatchObject({ status: 'live', hidden_by: null });
  });

  it('listing ẩn không do app (nối lại gian hàng khi sàn đang tắt) → SKU đang bán cũng không bật lại (25 §6.4)', async () => {
    const { listingId } = await seed(shops.lazada, 'hidden');
    await testPool().query(
      "insert into core.state_transitions (company_id, entity_type, entity_id, from_state, to_state, action, source) values ($1, 'listings', $2, null, 'hidden', 'relist', 'system')",
      [company.companyId, listingId],
    );
    await runPush(shops.lazada);
    expect(activate).not.toHaveBeenCalled();
    expect(await listing(listingId)).toMatchObject({ status: 'hidden' });
  });

  it('sàn từ chối tắt một SKU → listing đó giữ live (lượt sau thử lại), SKU khác vẫn ẩn', async () => {
    const bad = await seed(shops.lazada);
    const good = await seed(shops.lazada);
    await setStatus(bad.variantId, 'paused');
    await setStatus(good.variantId, 'paused');
    deactivate.mockImplementation(async (_t, _p, skuId) => {
      if (skuId === `sku-${bad.sku}`) throw new MarketplaceError('rejected', 'E1', 'Sàn từ chối');
    });
    await runPush(shops.lazada);
    expect(await listing(bad.listingId)).toMatchObject({ status: 'live', hidden_by: null });
    expect(await listing(good.listingId)).toMatchObject({ status: 'hidden' });

    deactivate.mockImplementation(async () => {});
    await runPush(shops.lazada);
    expect(await listing(bad.listingId)).toMatchObject({ status: 'hidden', hidden_by: 'platform' });
  });

  it('tồn đổi (version tăng) trong lúc gọi sàn tắt → vẫn ghi hidden trên dòng mới, app không lệch sàn', async () => {
    const { variantId, listingId } = await seed(shops.lazada);
    await setStatus(variantId, 'paused');
    deactivate.mockImplementationOnce(async () => {
      await testPool().query("update channel.listings set version = version + 1, stock_sync = 'pending' where id = $1", [listingId]);
    });
    await runPush(shops.lazada);
    expect(await listing(listingId)).toMatchObject({ status: 'hidden', hidden_by: 'platform' });
  });

  it('sự kiện không dính tạm ngừng (selling → discontinued) → không xếp việc', async () => {
    const { variantId } = await seed(shops.lazada);
    await clearJobs(shops.lazada);
    await changeStatus(variantId, 'selling', 'discontinued');
    expect(await pushJobs(shops.lazada)).toEqual([]);
  });

  it('E25: SKU tạm ngừng khi listing under_review; sàn duyệt ở lượt đồng bộ → cuối lượt listing hidden, không live', async () => {
    const { variantId, sku, listingId } = await seed(shops.lazada, 'under_review');
    await setStatus(variantId, 'paused');
    remote = [
      { externalProductId: `item-${sku}`, externalSkuId: `sku-${sku}`, sellerSku: sku, title: 'x', state: 'live', rejectReason: null, quantity: 5 },
    ];
    await syncListings(port(), company.companyId, shops.lazada);
    expect(deactivate).toHaveBeenCalledWith(expect.any(String), `item-${sku}`, `sku-${sku}`);
    expect(await listing(listingId)).toMatchObject({ status: 'hidden', hidden_by: 'platform' });
  });

  it('listing hidden bị sàn khoá → platform_hold không vướng CHECK listings_hidden_by', async () => {
    const { variantId, sku, listingId } = await seed(shops.lazada);
    await changeStatus(variantId, 'selling', 'paused');
    await runPush(shops.lazada);
    remote = [
      { externalProductId: `item-${sku}`, externalSkuId: `sku-${sku}`, sellerSku: sku, title: 'x', state: 'hold', rejectReason: null, quantity: 5 },
    ];
    await syncListings(port(), company.companyId, shops.lazada);
    expect(await listing(listingId)).toMatchObject({ status: 'platform_hold', hidden_by: null });
  });
});

describe('gian hàng hideBy = zero_stock', () => {
  it('C2-13: tạm ngừng → không gọi tắt, sàn nhận tồn 0, hidden_by zero_stock; đồng bộ sau không đẩy lại số thật, không Lệch tồn', async () => {
    const { variantId, sku, listingId } = await seed(shops.shopee);
    await changeStatus(variantId, 'selling', 'paused');
    await runPush(shops.shopee);
    expect(deactivate).not.toHaveBeenCalled();
    expect(sent().find((i) => i.externalSkuId === `sku-${sku}`)).toMatchObject({ quantity: 0 });
    expect(await listing(listingId)).toMatchObject({ status: 'hidden', hidden_by: 'zero_stock', stock_sync: 'synced', platform_stock: 0 });

    // Hai lượt đối chiếu: sàn 0 khớp số nên có (0), không đẩy 5, không bật `error`.
    remote = [
      { externalProductId: `item-${sku}`, externalSkuId: `sku-${sku}`, sellerSku: sku, title: 'x', state: 'live', rejectReason: null, quantity: 0, sellableQuantity: 0 },
    ];
    vi.clearAllMocks();
    await syncListings(port(), company.companyId, shops.shopee);
    await syncListings(port(), company.companyId, shops.shopee);
    expect(sent().find((i) => i.externalSkuId === `sku-${sku}`)).toBeUndefined();
    expect(await listing(listingId)).toMatchObject({ status: 'hidden', stock_sync: 'synced' });
  });

  it('C2-14: bỏ tạm ngừng → không gọi bật, sàn nhận lại số có thể bán, listing live', async () => {
    const { variantId, sku, listingId } = await seed(shops.shopee);
    await changeStatus(variantId, 'selling', 'paused');
    await runPush(shops.shopee);
    vi.clearAllMocks();
    await changeStatus(variantId, 'paused', 'selling');
    await runPush(shops.shopee);
    expect(activate).not.toHaveBeenCalled();
    expect(sent().find((i) => i.externalSkuId === `sku-${sku}`)).toMatchObject({ quantity: 5 });
    expect(await listing(listingId)).toMatchObject({ status: 'live', hidden_by: null, stock_sync: 'synced' });
  });
});
