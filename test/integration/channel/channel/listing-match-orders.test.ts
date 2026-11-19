// Ghép SKU có hiệu lực thì áp lên đơn đã về (spec 237 §5.3; AC1, AC9, AC10, AC13, AC14, AC16, 16e; PR 2: 17, 19, 25). Biến thể thật của
// catalog, tồn thật; mỗi ca dùng SKU sàn và biến thể riêng.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ChannelListing } from '#src/modules/channel/channel/api/schemas.ts';
import { variantsBySellerSku } from '#src/modules/channel/channel/repository/raw-orders.ts';
import type { RemoteSku } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { inBackground, registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { runRemoteSkusRefresh } from '#src/modules/channel/channel/service/remote-skus.ts';
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
    // Tải lại xếp việc (202, #361) rồi chạy việc như worker, lần thử cuối.
    expect((await as(app().post(`/api/v1/channel/shops/${shopId}/remote-skus/refresh`), company.ceo.token)).status).toBe(202);
    await inBackground(() => runRemoteSkusRefresh({ companyId: company.companyId, shopId }, { attempt: 2, lastAttempt: true }));
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
  it('D2-G01 AC1: Sale ghép SKU sàn với biến thể → 200; dòng đơn đã về có biến thể; đơn không còn cờ unmapped_sku', async () => {
    const r = newRemote();
    const v = await variant();
    const { orderId } = await orderOf(r.sellerSku);
    expect(await flagsOf(orderId)).toContain('unmapped_sku');

    expect((await match(sale.token, { externalSkuId: r.externalSkuId, variantId: v.variantId })).status).toBe(200);

    expect(await lineOf(orderId)).toEqual({ variant_id: v.variantId, stock_untracked: false });
    expect(await flagsOf(orderId)).not.toContain('unmapped_sku');
  });

  it('D2-G06 AC9, AC10: Sale ghép "không quản tồn" → 202, đơn chưa đổi; CEO duyệt → dòng đơn stock_untracked, cờ tắt', async () => {
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

  // PR 1: đơn đã về giữ A (AC16). PR 2: đơn còn mở có kiện chưa rời kho đổi theo (ca D2-G10 17); kiện đã rời kho vẫn giữ A.
  it('AC16, D2-G14 22: CEO đổi ghép A → B: đơn đã về có kiện đã rời kho giữ A; đơn về sau theo B', async () => {
    const r = newRemote();
    const a = await variant();
    const b = await variant();
    expect((await match(company.ceo.token, { externalSkuId: r.externalSkuId, variantId: a.variantId })).status).toBe(200);
    const before = await orderOf(r.sellerSku, { variantId: a.variantId, status: 'in_transit' });

    expect((await match(company.ceo.token, { externalSkuId: r.externalSkuId, variantId: b.variantId })).status).toBe(200);

    expect(await lineOf(before.orderId)).toEqual({ variant_id: a.variantId, stock_untracked: false });
    const sku = (await withCompany(company.companyId, () => variantsBySellerSku(shopId, [r.sellerSku]))).get(r.sellerSku);
    expect(sku).toEqual({ kind: 'variant', variantId: b.variantId });
    const after = await orderOf(r.sellerSku, { variantId: sku?.kind === 'variant' ? sku.variantId : null });
    expect(await lineOf(after.orderId)).toEqual({ variant_id: b.variantId, stock_untracked: false });
  });

  it('D2-G08 AC13: ghép đã đúng từ trước (dữ liệu trước PR), đơn cũ còn dòng chưa ghép → bấm ghép lại cùng biến thể thì đơn được áp', async () => {
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

  it('D2-G09 AC14: cổng tồn ném lỗi giữa lúc áp → 500; listing không tạo, dòng đơn vẫn chưa ghép', async () => {
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

// Đổi ghép đã dùng qua API (spec 237 §9 PR 2: 17, 19, 25). CEO tự duyệt đổi ghép.
describe('đổi ghép đã có đơn dùng (spec 237 §5.5 bảng 2, §5.6)', () => {
  const packageLineOf = async (orderId: string) =>
    (
      await testPool().query(
        `select l.variant_id, l.remap_pending from "order".package_lines l join "order".packages p on p.id = l.package_id where p.order_id = $1`,
        [orderId],
      )
    ).rows[0];

  it('D2-G10 17 qua listings/match: CEO đổi ghép A → B (200), đơn đã về có kiện reserved → dòng đơn và dòng kiện là B', async () => {
    const r = newRemote();
    const a = await variant();
    const b = await variant();
    expect((await match(company.ceo.token, { externalSkuId: r.externalSkuId, variantId: a.variantId })).status).toBe(200);
    const { orderId, packageId } = await orderOf(r.sellerSku, { variantId: a.variantId });
    expect((await testPool().query('select status from "order".packages where id = $1', [packageId])).rows[0].status).toBe('reserved');

    expect((await match(company.ceo.token, { externalSkuId: r.externalSkuId, variantId: b.variantId })).status).toBe(200);

    expect(await lineOf(orderId)).toEqual({ variant_id: b.variantId, stock_untracked: false });
    expect(await packageLineOf(orderId)).toEqual({ variant_id: b.variantId, remap_pending: false });
  });

  it('D2-G11 19 qua listings/match: kiện packed → GET có openPurpose remap; ready 409 awaiting_open; kiện awaiting_pickup quét bàn giao failed[].code awaiting_open', async () => {
    const r = newRemote();
    const a = await variant();
    const b = await variant();
    expect((await match(company.ceo.token, { externalSkuId: r.externalSkuId, variantId: a.variantId })).status).toBe(200);
    const { orderId, packageId } = await orderOf(r.sellerSku, { variantId: a.variantId, status: 'packed' });
    const waiting = await orderOf(r.sellerSku, { variantId: a.variantId, status: 'awaiting_pickup' });

    expect((await match(company.ceo.token, { externalSkuId: r.externalSkuId, variantId: b.variantId })).status).toBe(200);

    expect(await lineOf(orderId)).toEqual({ variant_id: a.variantId, stock_untracked: false });
    expect(await packageLineOf(orderId)).toEqual({ variant_id: a.variantId, remap_pending: true });
    const pkg = (await as(app().get(`/api/v1/fulfillment/packages/${packageId}`), company.ceo.token).expect(200)).body;
    expect(pkg.openPurpose).toBe('remap');
    const ready = await as(app().post(`/api/v1/fulfillment/packages/${packageId}/ready`), company.ceo.token).send({ version: pkg.version });
    expect(ready.status).toBe(409);
    expect(ready.body.type).toMatch(/awaiting_open$/);
    const other = (await as(app().get(`/api/v1/fulfillment/packages/${waiting.packageId}`), company.ceo.token).expect(200)).body;
    expect(other.openPurpose).toBe('remap');
    const scan = await as(app().post('/api/v1/fulfillment/packages/hand-over'), company.ceo.token).send({
      packages: [{ id: waiting.packageId, version: other.version }],
    });
    expect(scan.status).toBe(200);
    expect(scan.body.failed.map((f: { code: string }) => f.code)).toEqual(['awaiting_open']);
  });

  it('D2-G16 25: cổng tồn ném lỗi lúc đổi ghép → 500, listing vẫn ghép A, dòng đơn, dòng kiện, cờ không đổi', async () => {
    const r = newRemote();
    const a = await variant();
    const b = await variant();
    expect((await match(company.ceo.token, { externalSkuId: r.externalSkuId, variantId: a.variantId })).status).toBe(200);
    const { orderId, packageId } = await orderOf(r.sellerSku, { variantId: a.variantId });
    setStockPort({
      reserve: async () => {
        throw new Error('hỏng');
      },
    });

    expect((await match(company.ceo.token, { externalSkuId: r.externalSkuId, variantId: b.variantId })).status).toBe(500);

    expect((await rowOf(r.externalSkuId)).variant_id).toBe(a.variantId);
    expect(await lineOf(orderId)).toEqual({ variant_id: a.variantId, stock_untracked: false });
    expect(await packageLineOf(orderId)).toEqual({ variant_id: a.variantId, remap_pending: false });
    expect((await testPool().query('select status, needs_open from "order".packages where id = $1', [packageId])).rows[0]).toEqual({
      status: 'reserved',
      needs_open: false,
    });
  });
});
