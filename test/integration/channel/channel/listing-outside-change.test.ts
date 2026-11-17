// Sàn đổi listing ngoài app, phần trạng thái (#360; 25 §6.4, 6.5; 21 §18.3 `outside_hold`, `outside_resolve`, route
// `outside-change/:action`; 19 CHECK `listings_outside_change`).
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
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { activateShop, fakeAdapter } from './helpers.ts';

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
// TikTok có `activate` như adapter thật (bật cả sản phẩm, phải duyệt lại).
registerAdapter('tiktok', fakeAdapter({ getSeller: seller, getSkus, updatePriceQuantity, deactivate, activate, togglesByProduct: true }));
afterAll(() => resetAdapters());

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
let shopId = '';
const port = () => productPort(createModuleContext());

async function connect(platform: 'lazada' | 'tiktok') {
  const res = await app()
    .post(`/api/v1/channel/shops/${platform}/token`)
    .set('Authorization', `Bearer ${company.ceo.token}`)
    .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  await activateShop(res.body.shop.id);
  return res.body.shop.id as string;
}

/** Listing `live` đã đồng bộ tồn, giá; hoặc đang chờ CEO quyết vì sàn tắt ngoài app (ghi kèm lịch sử `outside_hold`). */
async function seed(shop = shopId, outside = false) {
  const { variantId, sku } = await createVariant(company.companyId);
  await receive(company.companyId, variantId, 5, 1000);
  const { rows } = await testPool().query(
    `insert into channel.listings (company_id, shop_id, variant_id, external_product_id, external_sku_id, seller_sku, status,
       stock_sync, price_sync, platform_stock, listed_price, hidden_by, outside_change_kind, outside_change_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'synced', 'synced', 5, 100000, $8, $9, $10) returning id`,
    [
      company.companyId,
      shop,
      variantId,
      `item-${sku}`,
      `sku-${sku}`,
      sku,
      outside ? 'hidden' : 'live',
      outside ? 'platform' : null,
      outside ? 'disabled' : null,
      outside ? new Date() : null,
    ],
  );
  const listingId = rows[0].id as string;
  if (outside) {
    await testPool().query(
      "insert into core.state_transitions (company_id, entity_type, entity_id, from_state, to_state, action, source) values ($1, 'listings', $2, 'live', 'hidden', 'outside_hold', 'system')",
      [company.companyId, listingId],
    );
  }
  return { variantId, sku, listingId };
}
const remoteSku = (sku: string, state: RemoteSku['state']): RemoteSku => ({
  externalProductId: `item-${sku}`,
  externalSkuId: `sku-${sku}`,
  sellerSku: sku,
  title: 'x',
  state,
  rejectReason: null,
  quantity: 5,
  sellableQuantity: 5,
});
const setStatus = (variantId: string, status: string) =>
  testPool().query('update product.product_variants set business_status = $2 where id = $1', [variantId, status]);
async function changeStatus(variantId: string, from: string, to: string) {
  await setStatus(variantId, to);
  await withCompany(company.companyId, () =>
    onVariantStatusChanged({ variantId, productId: randomUUID(), from, to, changedAt: new Date().toISOString() } as never),
  );
}
const sync = (shop = shopId) => syncListings(port(), company.companyId, shop);
const runPush = (shop = shopId) => runStockPush(port(), { companyId: company.companyId, shopId: shop });
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
const sentSkus = () => updatePriceQuantity.mock.calls.flatMap(([, items]) => items.map((i) => i.externalSkuId));

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  shopId = await connect('lazada');
});
beforeEach(() => {
  vi.clearAllMocks();
  remote = [];
});

describe('lượt đồng bộ: sàn tắt SKU ngoài app (outside_hold)', () => {
  it('AC-1: listing live, sàn báo tắt → hidden, hidden_by platform, outsideChange disabled, hệ thống ghi outside_hold', async () => {
    const { sku, listingId } = await seed();
    remote = [remoteSku(sku, 'inactive')];
    await sync();
    const row = await listing(listingId);
    expect(row).toMatchObject({ status: 'hidden', hidden_by: 'platform', outside_change_kind: 'disabled', outside_change_price: null });
    expect(row.outside_change_at).toBeInstanceOf(Date);
    expect(await lastTransition(listingId)).toMatchObject({ action: 'outside_hold', from_state: 'live', to_state: 'hidden', actor_id: null });
  });

  it('AC-2: listing app đã ẩn (SKU tạm ngừng), sàn báo tắt → giữ hidden, không ghi outsideChange', async () => {
    const { variantId, sku, listingId } = await seed();
    await changeStatus(variantId, 'selling', 'paused');
    await runPush();
    remote = [remoteSku(sku, 'inactive')];
    await sync();
    expect(await listing(listingId)).toMatchObject({ status: 'hidden', outside_change_kind: null });
  });

  it('AC-S5: SKU tạm ngừng mà listing còn live (việc đẩy tồn chưa kịp ẩn), sàn báo tắt → app tự hide, không outside_hold', async () => {
    const { variantId, sku, listingId } = await seed();
    await setStatus(variantId, 'paused');
    remote = [remoteSku(sku, 'inactive')];
    await sync();
    expect(await listing(listingId)).toMatchObject({ status: 'hidden', outside_change_kind: null });
    expect(await lastTransition(listingId)).toMatchObject({ action: 'hide' });
  });

  it('AC-3, AC-S4: listing chờ CEO quyết → không đẩy tồn, không đẩy giá dù đang chờ đẩy; đối chiếu không bật Lệch tồn', async () => {
    const { variantId, sku, listingId } = await seed(shopId, true);
    await receive(company.companyId, variantId, 3, 1000);
    await testPool().query("update channel.listings set stock_sync = 'pending', price_sync = 'pending' where id = $1", [listingId]);
    remote = [{ ...remoteSku(sku, 'inactive'), sellableQuantity: 1 }];
    await sync();
    await sync();
    expect(sentSkus()).not.toContain(`sku-${sku}`);
    expect(await listing(listingId)).toMatchObject({ status: 'hidden', stock_sync: 'pending', price_sync: 'pending' });
  });

  it('AC-4: listing chờ CEO quyết, SKU tạm ngừng rồi bỏ tạm ngừng → vẫn hidden, không bật lại trên sàn', async () => {
    const { variantId, listingId } = await seed(shopId, true);
    await changeStatus(variantId, 'selling', 'paused');
    await runPush();
    await changeStatus(variantId, 'paused', 'selling');
    await runPush();
    expect(activate).not.toHaveBeenCalled();
    expect(await listing(listingId)).toMatchObject({ status: 'hidden', outside_change_kind: 'disabled' });
  });

  it('TikTok (#224 phần 2): SKU tạm ngừng mà sàn báo tắt → app tự hide bằng tồn 0, không outside_hold', async () => {
    const tiktok = await connect('tiktok');
    const { variantId, sku, listingId } = await seed(tiktok);
    await setStatus(variantId, 'paused');
    remote = [remoteSku(sku, 'inactive')];
    await sync(tiktok);
    expect(await listing(listingId)).toMatchObject({ status: 'hidden', hidden_by: 'zero_stock', outside_change_kind: null });
  });

  it('TikTok: SELLER_DEACTIVATED (inactive) cũng outside_hold', async () => {
    const tiktok = await connect('tiktok');
    const { sku, listingId } = await seed(tiktok);
    remote = [remoteSku(sku, 'inactive')];
    await sync(tiktok);
    expect(await listing(listingId)).toMatchObject({ status: 'hidden', outside_change_kind: 'disabled' });
  });
});

describe('rời hidden thì bỏ outsideChange (CHECK listings_outside_change)', () => {
  it('sàn khoá listing chờ CEO quyết → platform_hold, ba cột rỗng', async () => {
    const { sku, listingId } = await seed(shopId, true);
    remote = [remoteSku(sku, 'hold')];
    await sync();
    expect(await listing(listingId)).toMatchObject({
      status: 'platform_hold',
      hidden_by: null,
      outside_change_kind: null,
      outside_change_at: null,
    });
  });

  it('sàn xoá sản phẩm → delisted, ba cột rỗng', async () => {
    const { sku, listingId } = await seed(shopId, true);
    remote = [remoteSku(sku, 'deleted')];
    await sync();
    expect(await listing(listingId)).toMatchObject({ status: 'delisted', outside_change_kind: null });
  });

  it('CEO gỡ tay listing chờ quyết → delisted, ba cột rỗng', async () => {
    const { variantId, listingId } = await seed(shopId, true);
    const { version } = await listing(listingId);
    const res = await app()
      .post(`/api/v1/channel/shops/${shopId}/listings/${variantId}/delist`)
      .set('Authorization', `Bearer ${company.ceo.token}`)
      .send({ version });
    expect(res.status).toBe(200);
    expect(await listing(listingId)).toMatchObject({ status: 'delisted', outside_change_kind: null });
  });

  it('ngắt gian hàng có listing chờ quyết → không lỗi, listing delisted, ba cột rỗng', async () => {
    const shop = await connect('lazada');
    const { listingId } = await seed(shop, true);
    const { rows } = await testPool().query('select version from channel.shops where id = $1', [shop]);
    const res = await app()
      .post(`/api/v1/channel/shops/${shop}/disconnect`)
      .set('Authorization', `Bearer ${company.ceo.token}`)
      .send({ version: rows[0].version, zeroStock: false });
    expect(res.status).toBe(200);
    expect(await listing(listingId)).toMatchObject({ status: 'delisted', outside_change_kind: null });
  });

  it('DB từ chối outsideChange trên listing không hidden', async () => {
    const { listingId } = await seed();
    await expect(
      testPool().query("update channel.listings set outside_change_kind = 'disabled', outside_change_at = now() where id = $1", [listingId]),
    ).rejects.toThrow(/listings_outside_change/);
    await expect(testPool().query('update channel.listings set outside_change_at = now() where id = $1', [listingId])).rejects.toThrow(
      /listings_outside_change/,
    );
  });
});

describe('POST …/outside-change/:action (CEO quyết)', () => {
  const decide = (listingId: string, action: string, body: object, token = company.ceo.token, shop = shopId) =>
    app().post(`/api/v1/channel/shops/${shop}/listings/${listingId}/outside-change/${action}`).set('Authorization', `Bearer ${token}`).send(body);
  const versionOf = async (id: string) => (await listing(id)).version as number;

  it('AC-5: restore, sàn còn tắt → bật lại trên sàn, live, outsideChange null, tồn và giá chờ đẩy, xếp stock_push, lịch sử outside_resolve', async () => {
    const { sku, listingId } = await seed(shopId, true);
    remote = [remoteSku(sku, 'inactive')];
    await testPool().query("delete from pgboss.job where name = 'channel.stock_push' and data->>'shopId' = $1", [shopId]);
    const res = await decide(listingId, 'restore', { version: await versionOf(listingId) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'live', hiddenBy: null, outsideChange: null, stockSync: 'pending', priceSync: 'pending' });
    expect(activate).toHaveBeenCalledWith(expect.any(String), `item-${sku}`, `sku-${sku}`);
    expect(await listing(listingId)).toMatchObject({ status: 'live', outside_change_kind: null, outside_change_at: null });
    expect(await lastTransition(listingId)).toMatchObject({ action: 'outside_resolve', from_state: 'hidden', to_state: 'live' });
    const { rows } = await testPool().query("select 1 from pgboss.job where name = 'channel.stock_push' and data->>'shopId' = $1", [shopId]);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('AC-8: restore khi người bán đã tự bật lại trên sàn → không gọi bật, chỉ outside_resolve', async () => {
    const { sku, listingId } = await seed(shopId, true);
    remote = [remoteSku(sku, 'live')];
    const res = await decide(listingId, 'restore', { version: await versionOf(listingId) });
    expect(res.status).toBe(200);
    expect(activate).not.toHaveBeenCalled();
    expect(res.body.status).toBe('live');
  });

  it('AC-8: TikTok sàn còn tắt → bật cả sản phẩm, live (#224 phần 2)', async () => {
    const tiktok = await connect('tiktok');
    const { sku, listingId } = await seed(tiktok, true);
    remote = [remoteSku(sku, 'inactive')];
    const res = await decide(listingId, 'restore', { version: await versionOf(listingId) }, company.ceo.token, tiktok);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'live', outsideChange: null });
    expect(activate).toHaveBeenCalledWith(expect.any(String), `item-${sku}`, `sku-${sku}`);
  });

  it('Q2 TikTok: restore một listing → mọi listing disabled cùng sản phẩm cùng live; listing còn ẩn được đẩy tồn 0 trước khi bật', async () => {
    const tiktok = await connect('tiktok');
    const a = await seed(tiktok, true);
    const b = await seed(tiktok, true);
    const c = await seed(tiktok, true);
    await setStatus(c.variantId, 'paused');
    const product = `item-${a.sku}`;
    await testPool().query('update channel.listings set external_product_id = $1 where id = any($2)', [product, [b.listingId, c.listingId]]);
    remote = [{ ...remoteSku(a.sku, 'inactive'), externalProductId: product }];
    const res = await decide(a.listingId, 'restore', { version: await versionOf(a.listingId) }, company.ceo.token, tiktok);
    expect(res.status).toBe(200);
    expect(activate).toHaveBeenCalledTimes(1);
    for (const id of [a.listingId, b.listingId]) expect(await listing(id)).toMatchObject({ status: 'live', outside_change_kind: null });
    expect(await listing(c.listingId)).toMatchObject({ status: 'hidden', hidden_by: 'zero_stock', outside_change_kind: null });
    const zero = updatePriceQuantity.mock.calls.findIndex(([, items]) => items.some((i) => i.externalSkuId === `sku-${c.sku}` && i.quantity === 0));
    expect(zero).toBeGreaterThanOrEqual(0);
    expect(updatePriceQuantity.mock.invocationCallOrder[zero]!).toBeLessThan(activate.mock.invocationCallOrder[0]!);
  });

  it('Q2 TikTok: đẩy tồn 0 cho listing còn ẩn lỗi → không bật sản phẩm, mọi listing giữ nguyên', async () => {
    const tiktok = await connect('tiktok');
    const a = await seed(tiktok, true);
    const c = await seed(tiktok, true);
    await setStatus(c.variantId, 'paused');
    const product = `item-${a.sku}`;
    await testPool().query('update channel.listings set external_product_id = $1 where id = $2', [product, c.listingId]);
    remote = [{ ...remoteSku(a.sku, 'inactive'), externalProductId: product }];
    updatePriceQuantity.mockImplementationOnce(async (_t, items) => items.map((i) => ({ externalSkuId: i.externalSkuId, ok: false, code: 'x', message: 'lỗi' })));
    const res = await decide(a.listingId, 'restore', { version: await versionOf(a.listingId) }, company.ceo.token, tiktok);
    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/marketplace_rejected$/);
    expect(activate).not.toHaveBeenCalled();
    expect(await listing(a.listingId)).toMatchObject({ status: 'hidden', outside_change_kind: 'disabled' });
    expect(await listing(c.listingId)).toMatchObject({ status: 'hidden', outside_change_kind: 'disabled' });
  });

  it('AC-6: restore khi SKU đang tạm ngừng → xoá outsideChange, giữ hidden; bỏ tạm ngừng sau đó thì tự bật lại', async () => {
    const { variantId, sku, listingId } = await seed(shopId, true);
    await setStatus(variantId, 'paused');
    const res = await decide(listingId, 'restore', { version: await versionOf(listingId) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'hidden', outsideChange: null });
    expect(activate).not.toHaveBeenCalled();
    expect(await lastTransition(listingId)).toMatchObject({ action: 'outside_resolve', from_state: 'hidden', to_state: 'hidden' });
    remote = [remoteSku(sku, 'inactive')];
    await changeStatus(variantId, 'paused', 'selling');
    await runPush();
    expect(activate).toHaveBeenCalledWith(expect.any(String), `item-${sku}`, `sku-${sku}`);
    expect(await listing(listingId)).toMatchObject({ status: 'live', hidden_by: null });
  });

  it('review diff: tồn đổi (version tăng) trong lúc gọi sàn bật → vẫn ghi live trên dòng mới, không kẹt hidden', async () => {
    const { sku, listingId } = await seed(shopId, true);
    remote = [remoteSku(sku, 'inactive')];
    activate.mockImplementationOnce(async () => {
      await testPool().query("update channel.listings set version = version + 1, stock_sync = 'pending' where id = $1", [listingId]);
    });
    const res = await decide(listingId, 'restore', { version: await versionOf(listingId) });
    expect(res.status).toBe(200);
    expect(await listing(listingId)).toMatchObject({ status: 'live', outside_change_kind: null });
  });

  it('TikTok, SKU tạm ngừng → xoá outsideChange, giữ hidden ẩn bằng tồn 0, không bật sản phẩm', async () => {
    const tiktok = await connect('tiktok');
    const { variantId, sku, listingId } = await seed(tiktok, true);
    await setStatus(variantId, 'paused');
    remote = [remoteSku(sku, 'inactive')];
    const res = await decide(listingId, 'restore', { version: await versionOf(listingId) }, company.ceo.token, tiktok);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'hidden', outsideChange: null, hiddenBy: 'zero_stock' });
    expect(activate).not.toHaveBeenCalled();
  });

  it('AC-7: không có outsideChange → 409 invalid_transition; accept-price với disabled → 409; version cũ → 409 version_conflict', async () => {
    const plain = await seed();
    const r1 = await decide(plain.listingId, 'restore', { version: await versionOf(plain.listingId) });
    expect(r1.status).toBe(409);
    expect(r1.body.type).toMatch(/invalid_transition$/);
    const { listingId } = await seed(shopId, true);
    const r2 = await decide(listingId, 'accept-price', { version: await versionOf(listingId) });
    expect(r2.status).toBe(409);
    expect(r2.body.type).toMatch(/invalid_transition$/);
    const r3 = await decide(listingId, 'restore', { version: (await versionOf(listingId)) + 1 });
    expect(r3.status).toBe(409);
    expect(r3.body.type).toMatch(/version_conflict$/);
    expect(await listing(listingId)).toMatchObject({ status: 'hidden', outside_change_kind: 'disabled' });
  });

  it('AC-S1: Admin (có listing.manage, không phải CEO) → 403; Sale (thiếu listing.manage) → 403; action lạ → 422; công ty khác → 404', async () => {
    const { listingId } = await seed(shopId, true);
    const version = await versionOf(listingId);
    const admin = await addMember(company.companyId, 'admin');
    expect((await decide(listingId, 'restore', { version }, admin.token)).status).toBe(403);
    const sale = await addMember(company.companyId, 'sale');
    expect((await decide(listingId, 'restore', { version }, sale.token)).status).toBe(403);
    const bad = await decide(listingId, 'force', { version });
    expect(bad.status).toBe(422);
    const other = await createCompany({ optionalModules: ['channel'] });
    expect((await decide(listingId, 'restore', { version }, other.ceo.token)).status).toBe(404);
    expect(await listing(listingId)).toMatchObject({ status: 'hidden', outside_change_kind: 'disabled' });
  });
});
