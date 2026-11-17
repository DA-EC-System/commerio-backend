// Ghép SKU có hiệu lực thì áp lên đơn đã về (spec 237 §5.3; AC1, AC9, AC10, AC13, AC14, AC16, 16e). Biến thể thật của
// catalog, tồn thật; mỗi ca dùng SKU sàn và biến thể riêng.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ChannelListing } from '#src/modules/channel/channel/api/schemas.ts';
import { variantsBySellerSku } from '#src/modules/channel/channel/repository/raw-orders.ts';
import type { RemoteSku } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import type { PlatformOrder } from '#src/modules/order/index.ts';
import { setStockPort } from '#src/modules/order/fulfillment/service/stock-port.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { raceBehindLock } from '../../helpers/locks.ts';
import { ingest, type LineStatus, remote as platformOrder } from '../../order/fulfillment/platform-fixtures.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { activateShop, fakeAdapter } from './helpers.ts';

const remote: RemoteSku[] = [];
/** SKU mới trên sàn chưa vào bản sao: tải lại bản sao trước khi ghép. */
let dirty = false;
const newRemote = () => {
  const id = randomUUID().slice(0, 8);
  const r: RemoteSku = {
    externalProductId: `item-${id}`,
    externalSkuId: `sku-${id}`,
    sellerSku: `LZ-${id}`,
    title: `Cốc ${id}`,
    state: 'live',
    rejectReason: null,
    quantity: 3,
  };
  remote.push(r);
  dirty = true;
  return r;
};
registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
    },
    listSkus: async () => remote,
    getSkus: async (_t, skus) => remote.filter((r) => skus.includes(r.sellerSku)),
  }),
);
afterAll(() => resetAdapters());
afterEach(() => setStockPort());

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
let sale: Awaited<ReturnType<typeof addMember>>;
let shopId: string;
const as = (r: request.Test, token: string) => r.set('Authorization', `Bearer ${token}`);
const match = async (token: string, body: { externalSkuId: string; variantId: string | null }) => {
  if (dirty) {
    dirty = false;
    await testPool().query('update channel.shops set remote_skus_synced_at = null where id = $1', [shopId]);
    expect((await as(app().post(`/api/v1/channel/shops/${shopId}/remote-skus/refresh`), company.ceo.token)).status).toBe(200);
  }
  return as(app().post(`/api/v1/channel/shops/${shopId}/listings/match`), token).send(body);
};
const approve = (listingId: string, version: number) =>
  as(app().post(`/api/v1/channel/shops/${shopId}/listings/${listingId}/mapping/approve`), company.ceo.token).send({ version });

/** Biến thể thật có tồn. */
async function variant(stock = 10) {
  const v = await createVariant(company.companyId);
  if (stock) await receive(company.companyId, v.variantId, stock, 100000);
  return v;
}

/** Đơn đã về của gian hàng: một món mang SKU người bán `sellerSku`, biến thể theo lần tra lúc nhận (null: chưa ghép). */
async function orderOf(sellerSku: string, o: { variantId?: string | null; status?: LineStatus } = {}) {
  const any = await createVariant(company.companyId);
  const base = platformOrder(any, { status: o.status, lines: 0, unmapped: 1 });
  const order: PlatformOrder = { ...base, shopId, lines: base.lines.map((l) => ({ ...l, sellerSku, variantId: o.variantId ?? null })) };
  return ingest(company.companyId, order);
}

const lineOf = async (orderId: string) =>
  (await testPool().query('select variant_id, stock_untracked from "order".order_lines where order_id = $1', [orderId])).rows[0];
const flagsOf = async (orderId: string) =>
  (await as(app().get(`/api/v1/sales/orders/${orderId}`), company.ceo.token).expect(200)).body.flags as string[];
const rowOf = async (externalSkuId: string) =>
  (
    await testPool().query('select id, mode, variant_id, version from channel.listings where shop_id = $1 and external_sku_id = $2', [
      shopId,
      externalSkuId,
    ])
  ).rows[0];

beforeAll(async () => {
  setProductPort(null);
  company = await createCompany({ optionalModules: ['channel'] });
  sale = await addMember(company.companyId, 'sale');
  const res = await as(app().post('/api/v1/channel/shops/lazada/token'), company.ceo.token).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  shopId = res.body.shop.id;
  await activateShop(shopId);
});

describe('ghép SKU áp lên đơn đã về (spec 237 §5.3)', () => {
  it('AC1: Sale ghép SKU sàn với biến thể → 200; dòng đơn đã về có biến thể; đơn không còn cờ unmapped_sku', async () => {
    const r = newRemote();
    const v = await variant();
    const { orderId } = await orderOf(r.sellerSku);
    expect(await flagsOf(orderId)).toContain('unmapped_sku');

    expect((await match(sale.token, { externalSkuId: r.externalSkuId, variantId: v.variantId })).status).toBe(200);

    expect(await lineOf(orderId)).toEqual({ variant_id: v.variantId, stock_untracked: false });
    expect(await flagsOf(orderId)).not.toContain('unmapped_sku');
  });

  it('AC9, AC10: Sale ghép "không quản tồn" → 202, đơn chưa đổi; CEO duyệt → dòng đơn stock_untracked, cờ tắt', async () => {
    const r = newRemote();
    const { orderId } = await orderOf(r.sellerSku);

    const requested = await match(sale.token, { externalSkuId: r.externalSkuId, variantId: null });
    expect(requested.status).toBe(202);
    expect(await lineOf(orderId)).toEqual({ variant_id: null, stock_untracked: false });
    expect(await flagsOf(orderId)).toContain('unmapped_sku');

    const listing = ChannelListing.parse(requested.body);
    expect((await approve(listing.id, listing.version)).status).toBe(200);
    expect(await lineOf(orderId)).toEqual({ variant_id: null, stock_untracked: true });
    expect(await flagsOf(orderId)).not.toContain('unmapped_sku');
  });

  it('AC16: CEO đổi ghép A → B: đơn đã về giữ A; đơn về sau theo B', async () => {
    const r = newRemote();
    const a = await variant();
    const b = await variant();
    expect((await match(company.ceo.token, { externalSkuId: r.externalSkuId, variantId: a.variantId })).status).toBe(200);
    const before = await orderOf(r.sellerSku, { variantId: a.variantId });

    expect((await match(company.ceo.token, { externalSkuId: r.externalSkuId, variantId: b.variantId })).status).toBe(200);

    expect(await lineOf(before.orderId)).toEqual({ variant_id: a.variantId, stock_untracked: false });
    const sku = (await withCompany(company.companyId, () => variantsBySellerSku(shopId, [r.sellerSku]))).get(r.sellerSku);
    expect(sku).toEqual({ kind: 'variant', variantId: b.variantId });
    const after = await orderOf(r.sellerSku, { variantId: sku?.kind === 'variant' ? sku.variantId : null });
    expect(await lineOf(after.orderId)).toEqual({ variant_id: b.variantId, stock_untracked: false });
  });

  it('AC13: ghép đã đúng từ trước (dữ liệu trước PR), đơn cũ còn dòng chưa ghép → bấm ghép lại cùng biến thể thì đơn được áp', async () => {
    const r = newRemote();
    const v = await variant();
    await testPool().query(
      `insert into channel.listings (company_id, shop_id, variant_id, mode, seller_sku, status, external_sku_id, external_product_id)
       values ($1, $2, $3, 'mapped', $4, 'live', $5, $6)`,
      [company.companyId, shopId, v.variantId, r.sellerSku, r.externalSkuId, r.externalProductId],
    );
    const { orderId } = await orderOf(r.sellerSku);

    expect((await match(sale.token, { externalSkuId: r.externalSkuId, variantId: v.variantId })).status).toBe(200);

    expect(await lineOf(orderId)).toEqual({ variant_id: v.variantId, stock_untracked: false });
  });

  it('16e: hai listing chưa gỡ trùng SKU người bán → ghép lại dòng không thắng thì đơn đã về theo ghép của dòng thắng', async () => {
    const r = newRemote();
    const winner = await variant();
    const old = await variant();
    const target = await variant();
    await testPool().query(
      `insert into channel.listings (company_id, shop_id, variant_id, mode, seller_sku, status, external_sku_id, external_product_id, created_at)
       values ($1, $2, $3, 'mapped', $5, 'live', $6, 'P-OLD', now() - interval '1 day'),
              ($1, $2, $4, 'mapped', $5, 'live', $7, 'P-NEW', now())`,
      [company.companyId, shopId, old.variantId, winner.variantId, r.sellerSku, r.externalSkuId, `sku-${randomUUID().slice(0, 8)}`],
    );
    const { orderId } = await orderOf(r.sellerSku);

    expect((await match(sale.token, { externalSkuId: r.externalSkuId, variantId: target.variantId })).status).toBe(200);

    expect(await lineOf(orderId)).toEqual({ variant_id: winner.variantId, stock_untracked: false });
  });

  it('AC14: cổng tồn ném lỗi giữa lúc áp → 500; listing không tạo, dòng đơn vẫn chưa ghép', async () => {
    const r = newRemote();
    const v = await variant();
    const { orderId } = await orderOf(r.sellerSku, { status: 'in_transit' });
    setStockPort({
      ship: async () => {
        throw new Error('hỏng');
      },
    });

    expect((await match(sale.token, { externalSkuId: r.externalSkuId, variantId: v.variantId })).status).toBe(500);

    expect(await rowOf(r.externalSkuId)).toBeUndefined();
    expect(await lineOf(orderId)).toEqual({ variant_id: null, stock_untracked: false });
  });

  it('duyệt ghép khoá dòng gian hàng: lượt nhận đơn đang giữ khoá chia sẻ thì duyệt chờ tới khi lượt đó xong', async () => {
    const r = newRemote();
    const requested = await match(sale.token, { externalSkuId: r.externalSkuId, variantId: null });
    expect(requested.status).toBe(202);
    const listing = ChannelListing.parse(requested.body);

    const res = await raceBehindLock(
      (holder) => holder.query('select id from channel.shops where id = $1 for share', [shopId]),
      1,
      () => approve(listing.id, listing.version).then((x) => x),
    );

    expect(res.status).toBe(200);
  });
});
