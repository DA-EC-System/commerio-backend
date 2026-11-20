// Sàn đổi listing ngoài app, phần giá (#360; 25 §6.4, 6.5; 21 §18.3 `outside_hold` kind `price_changed`).
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PerSkuResult, PriceQuantity, RemoteSku } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { syncListings } from '#src/modules/channel/channel/service/listing-sync.ts';
import { productPort, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { createModuleContext } from '#src/wiring.ts';
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
registerAdapter(
  'tiktok',
  fakeAdapter({ getSeller: seller, getSkus, updatePriceQuantity, deactivate, activate, togglesByProduct: true, capabilities: { ...FAKE_CAPABILITIES, hideBy: 'zero_stock' } }),
);
afterAll(() => resetAdapters());

let company: Awaited<ReturnType<typeof createCompany>>;
let lazada = '';
let tiktok = '';
const port = () => productPort(createModuleContext());

async function connect(platform: 'lazada' | 'tiktok') {
  const res = await request(testApp())
    .post(`/api/v1/channel/shops/${platform}/token`)
    .set('Authorization', `Bearer ${company.ceo.token}`)
    .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  await activateShop(res.body.shop.id);
  return res.body.shop.id as string;
}

/** Listing đã đồng bộ, giá đẩy lần cuối 100.000; `pushedAgoMs` null là chưa ghi lúc đẩy. */
async function seed(shop: string, opts: { status?: 'live' | 'hidden'; pushedAgoMs?: number | null } = {}) {
  const { variantId, sku } = await createVariant(company.companyId);
  await receive(company.companyId, variantId, 5, 1000);
  const status = opts.status ?? 'live';
  const pushedAt = opts.pushedAgoMs == null ? null : new Date(Date.now() - opts.pushedAgoMs);
  const { rows } = await testPool().query(
    `insert into channel.listings (company_id, shop_id, variant_id, external_product_id, external_sku_id, seller_sku, status,
       stock_sync, price_sync, platform_stock, listed_price, hidden_by, last_pushed_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'synced', 'synced', 5, 100000, $8, $9) returning id`,
    [company.companyId, shop, variantId, `item-${sku}`, `sku-${sku}`, sku, status, status === 'hidden' ? 'platform' : null, pushedAt],
  );
  return { variantId, sku, listingId: rows[0].id as string };
}
const remoteSku = (sku: string, price: string | undefined, extra: Partial<RemoteSku> = {}): RemoteSku => ({
  externalProductId: `item-${sku}`,
  externalSkuId: `sku-${sku}`,
  sellerSku: sku,
  title: 'x',
  state: 'live',
  rejectReason: null,
  quantity: 5,
  sellableQuantity: 5,
  ...(price !== undefined && { price }),
  ...extra,
});
const sync = (shop: string) => syncListings(port(), company.companyId, shop);
const listing = async (id: string) => (await testPool().query('select * from channel.listings where id = $1', [id])).rows[0];
async function lastTransition(id: string) {
  const { rows } = await testPool().query(
    "select action, from_state, to_state, actor_id, reason from core.state_transitions where entity_type = 'listings' and entity_id = $1 order by id desc limit 1",
    [id],
  );
  return rows[0];
}
const sent = (sku: string) => updatePriceQuantity.mock.calls.flatMap(([, items]) => items.filter((i) => i.externalSkuId === `sku-${sku}`));

beforeAll(async () => {
  company = await createCompany({ optionalModules: [] });
  lazada = await connect('lazada');
  tiktok = await connect('tiktok');
});
beforeEach(() => {
  vi.clearAllMocks();
  remote = [];
});

describe('lượt đồng bộ: giá gốc trên sàn khác giá app đẩy lần cuối', () => {
  it('Lazada: listing live, sàn 95.000 khác 100.000 → app tắt SKU, hidden, outsideChange price_changed 95.000, không đẩy giá', async () => {
    const { sku, listingId } = await seed(lazada);
    remote = [remoteSku(sku, '95000.00')];
    await sync(lazada);
    const row = await listing(listingId);
    expect(row).toMatchObject({ status: 'hidden', hidden_by: 'platform', outside_change_kind: 'price_changed', listed_price: '100000.00' });
    expect(Number(row.outside_change_price)).toBe(95000);
    expect(deactivate).toHaveBeenCalledWith(expect.any(String), `item-${sku}`, `sku-${sku}`);
    expect(await lastTransition(listingId)).toMatchObject({ action: 'outside_hold', from_state: 'live', to_state: 'hidden', actor_id: null, reason: 'Giá trên sàn bị sửa' });
    expect(sent(sku)).toEqual([]);
  });

  it('TikTok (ẩn bằng tồn 0): hidden_by zero_stock, đẩy tồn 0, không đẩy giá, không gọi tắt', async () => {
    const { sku, listingId } = await seed(tiktok);
    remote = [remoteSku(sku, '120000')];
    await sync(tiktok);
    expect(await listing(listingId)).toMatchObject({ status: 'hidden', hidden_by: 'zero_stock', outside_change_kind: 'price_changed', platform_stock: 0 });
    expect(deactivate).not.toHaveBeenCalled();
    expect(sent(sku)).toEqual([{ externalProductId: `item-${sku}`, externalSkuId: `sku-${sku}`, quantity: 0 }]);
  });

  it('lượt sau: listing chờ CEO quyết không bị đẩy giá đè, không ghi đè outsideChange', async () => {
    const { sku, listingId } = await seed(lazada);
    remote = [remoteSku(sku, '95000')];
    await sync(lazada);
    const before = await listing(listingId);
    remote = [remoteSku(sku, '90000', { state: 'inactive' })];
    await testPool().query("update channel.listings set price_sync = 'pending' where id = $1", [listingId]);
    vi.clearAllMocks();
    await sync(lazada);
    expect(sent(sku)).toEqual([]);
    expect(await listing(listingId)).toMatchObject({ outside_change_kind: 'price_changed', outside_change_price: before.outside_change_price });
  });

  it('listing app đã ẩn: chỉ ghi outsideChange, giữ hidden và cách ẩn, không gọi sàn', async () => {
    const { sku, listingId } = await seed(lazada, { status: 'hidden' });
    remote = [remoteSku(sku, '95000', { state: 'inactive' })];
    await sync(lazada);
    expect(await listing(listingId)).toMatchObject({ status: 'hidden', hidden_by: 'platform', outside_change_kind: 'price_changed' });
    expect(deactivate).not.toHaveBeenCalled();
  });

  it.each([
    ['giá bằng (chuỗi khác dạng)', '100000.00', {}, null],
    ['sàn không trả giá', undefined, {}, null],
    ['sàn khoá giá do khuyến mãi', '95000', { priceLocked: true }, null],
    ['vừa đẩy 5 phút trước (sàn có thể chưa áp)', '95000', {}, 5 * 60 * 1000],
  ])('không coi là sửa giá: %s', async (_n, price, extra, pushedAgoMs) => {
    const { sku, listingId } = await seed(lazada, { pushedAgoMs });
    remote = [remoteSku(sku, price, extra)];
    await sync(lazada);
    expect(await listing(listingId)).toMatchObject({ status: 'live', outside_change_kind: null });
  });

  it('đẩy lần cuối đã quá 15 phút thì so', async () => {
    const { sku, listingId } = await seed(lazada, { pushedAgoMs: 16 * 60 * 1000 });
    remote = [remoteSku(sku, '95000')];
    await sync(lazada);
    expect(await listing(listingId)).toMatchObject({ status: 'hidden', outside_change_kind: 'price_changed' });
  });

  it('sàn lỗi khi tắt SKU: giữ live, lượt sau thử lại', async () => {
    const { sku, listingId } = await seed(lazada);
    remote = [remoteSku(sku, '95000')];
    deactivate.mockRejectedValueOnce(new Error('sàn lỗi'));
    await sync(lazada);
    expect(await listing(listingId)).toMatchObject({ status: 'live', outside_change_kind: null });
  });
});

describe('POST …/outside-change/:action sau khi giá trên sàn bị sửa', () => {
  const decide = (listingId: string, action: string, version: number) =>
    request(testApp())
      .post(`/api/v1/channel/shops/${lazada}/listings/${listingId}/outside-change/${action}`)
      .set('Authorization', `Bearer ${company.ceo.token}`)
      .send({ version });
  /** Phí 14% + 3.000 mỗi món, lãi tối thiểu 10%, giá vốn 1.000 (seed): giá thấp nhất 1.100. */
  beforeAll(async () => {
    const fee = { fixedPct: 4, transactionPct: 5, servicePct: 3, optionalPct: 2, returnFee: 0, perItemFee: 3000 };
    await testPool().query(
      `insert into finance.config_versions (company_id, kind, shop_id, status, payload, effective_from, created_by, approved_by, approved_at)
       values ($1, 'fee', $2, 'active', $3, '2026-10-01', $4, $5, now()), ($1, 'min_margin', null, 'active', '{"pct":10}', '2026-10-01', $4, $5, now())`,
      [company.companyId, lazada, JSON.stringify(fee), randomUUID(), randomUUID()],
    );
  });
  async function changed(price: string) {
    const s = await seed(lazada);
    remote = [remoteSku(s.sku, price)];
    await sync(lazada);
    remote = [remoteSku(s.sku, price, { state: 'inactive' })];
    vi.clearAllMocks();
    return s;
  }

  it('accept-price: giá sàn thành giá ghi đè tay và giá đã đẩy, bật SKU, hidden → live, không đẩy giá', async () => {
    const { sku, listingId } = await changed('95000');
    const res = await decide(listingId, 'accept-price', (await listing(listingId)).version);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: 'live', outsideChange: null, priceSync: 'synced', lastPushedPrice: 95000 });
    expect(await listing(listingId)).toMatchObject({ status: 'live', manual_price: '95000.00', listed_price: '95000.00', hidden_by: null, stock_sync: 'pending' });
    expect(activate).toHaveBeenCalledWith(expect.any(String), `item-${sku}`, `sku-${sku}`);
    expect(await lastTransition(listingId)).toMatchObject({ action: 'outside_resolve', from_state: 'hidden', to_state: 'live' });
    expect(updatePriceQuantity.mock.calls.flatMap(([, items]) => items.filter((i) => i.price !== undefined))).toEqual([]);
  });

  it('accept-price: giá sàn dưới giá thấp nhất → 422 below_floor, listing giữ nguyên', async () => {
    const { listingId } = await changed('1000');
    const before = await listing(listingId);
    const res = await decide(listingId, 'accept-price', before.version);
    expect(res.status).toBe(422);
    expect(res.body.type).toMatch(/below_floor/);
    expect(await listing(listingId)).toMatchObject({ status: 'hidden', outside_change_kind: 'price_changed', manual_price: null, version: before.version });
    expect(activate).not.toHaveBeenCalled();
  });

  it('restore: đẩy lại giá app (price_sync pending), không đổi giá ghi đè', async () => {
    const { listingId } = await changed('95000');
    const res = await decide(listingId, 'restore', (await listing(listingId)).version);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await listing(listingId)).toMatchObject({ status: 'live', price_sync: 'pending', manual_price: null, listed_price: '100000.00', outside_change_kind: null });
  });
});
