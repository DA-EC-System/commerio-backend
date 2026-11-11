// Nối lại gian hàng đã ngắt: đưa lên lại listing gỡ do ngắt theo trạng thái sàn (#219 A6, Documents/25 §6.1).
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { jobBoss, stopJobs } from '#src/modules/core/platform/service/jobs/boss.ts';
import { MarketplaceError, type RemoteSku, type RemoteState } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { listingPushQueue } from '#src/modules/channel/channel/service/shop-jobs.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { fakeAdapter } from './helpers.ts';

/** Trạng thái trên sàn theo SellerSku; SellerSku không có thì sàn không trả. */
const remote = new Map<string, { state: RemoteState; rejectReason?: string }>();
let getSkusFails = false;
registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4, 16), shopName: 'Shop thử', region: 'VN' };
    },
    async getSkus(_t, sellerSkus): Promise<RemoteSku[]> {
      if (getSkusFails) throw new MarketplaceError('unavailable', '6', 'Sàn bận');
      return sellerSkus.flatMap((s) => {
        const r = remote.get(s);
        return r
          ? [{ externalProductId: `item-${s}`, externalSkuId: `sku-${s}`, sellerSku: s, title: s, state: r.state, rejectReason: r.rejectReason ?? null, quantity: 4 }]
          : [];
      });
    },
  }),
);
afterAll(async () => {
  resetAdapters();
  await stopJobs();
});

const app = () => request(testApp());

/** Gian hàng `active` đã thiết lập có listing `live` theo các SellerSku, rồi ngắt (listing gỡ do ngắt). */
async function disconnectedShop(skus: string[]) {
  const company = await createCompany({ optionalModules: ['channel'] });
  const token = `tok-${randomUUID().slice(0, 12)}`;
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${company.ceo.token}`);
  const res = await auth(app().post('/api/v1/channel/shops/lazada/token')).send({ accessToken: token });
  const shopId = res.body.shop.id as string;
  const { rows } = await testPool().query<{ version: number }>(
    `update channel.shops set status = 'active', order_cutoff_at = now(), version = version + 1 where id = $1 returning version`,
    [shopId],
  );
  for (const s of skus) {
    await testPool().query(
      `insert into channel.listings (company_id, shop_id, variant_id, seller_sku, status, external_product_id, external_sku_id, external_image_urls, stock_sync)
       values ($1, $2, $3, $4, 'live', $5, $6, $7, 'synced')`,
      [company.companyId, shopId, randomUUID(), s, `item-${s}`, `sku-${s}`, ['https://slatic.test/a.png']],
    );
  }
  const off = await auth(app().post(`/api/v1/channel/shops/${shopId}/disconnect`)).send({ version: rows[0]!.version });
  expect(off.status).toBe(200);
  return { shopId, reconnect: () => auth(app().post('/api/v1/channel/shops/lazada/token')).send({ accessToken: token }) };
}

const rowsOf = async (shopId: string) =>
  (
    await testPool().query(
      `select id, seller_sku, status, external_product_id, external_sku_id, external_image_urls, hidden_by, reject_reason,
              stock_sync, price_sync, platform_stock, replaces_listing_id, delisted_by_disconnect
       from channel.listings where shop_id = $1 order by seller_sku, created_at`,
      [shopId],
    )
  ).rows;

describe('nối lại gian hàng đã ngắt (#219 A6)', () => {
  it('AC-16: listing gỡ do ngắt mà sàn còn sản phẩm → dòng mới theo trạng thái sàn, trỏ dòng cũ; relisted = số dòng tạo', async () => {
    const tag = randomUUID().slice(0, 6);
    const sku = (k: string) => `R-${tag}-${k}`;
    const { shopId, reconnect } = await disconnectedShop(['A', 'B', 'C', 'D', 'E', 'F'].map(sku));
    remote.set(sku('A'), { state: 'live' });
    remote.set(sku('B'), { state: 'review' });
    remote.set(sku('C'), { state: 'deleted' });
    remote.set(sku('D'), { state: 'inactive' });
    remote.set(sku('E'), { state: 'rejected', rejectReason: 'Ảnh mờ' });
    remote.set(sku('F'), { state: 'hold' });

    const res = await reconnect();
    expect(res.status).toBe(200);
    expect(res.body.reconnect).toMatchObject({ relisted: 5 });

    const rows = await rowsOf(shopId);
    const bySku = (k: string) => rows.filter((r) => r.seller_sku === sku(k));
    expect(bySku('C')).toEqual([expect.objectContaining({ status: 'delisted' })]);
    const expected = { A: 'live', B: 'under_review', D: 'hidden', E: 'rejected', F: 'platform_hold' } as const;
    for (const [k, status] of Object.entries(expected)) {
      const [old, now] = bySku(k);
      expect(old).toMatchObject({ status: 'delisted', delisted_by_disconnect: true });
      expect(now).toMatchObject({
        status,
        replaces_listing_id: old.id,
        external_product_id: `item-${sku(k)}`,
        external_sku_id: `sku-${sku(k)}`,
        external_image_urls: ['https://slatic.test/a.png'],
        stock_sync: 'pending',
        price_sync: 'pending',
        platform_stock: 4,
        delisted_by_disconnect: false,
      });
    }
    expect(bySku('D')[1]).toMatchObject({ hidden_by: 'platform' });
    expect(bySku('E')[1]).toMatchObject({ reject_reason: 'Ảnh mờ' });
    const history = await testPool().query(
      `select from_state, to_state, action, actor_id from core.state_transitions where entity_type = 'listings' and entity_id = $1`,
      [bySku('A')[1].id],
    );
    expect(history.rows).toEqual([{ from_state: null, to_state: 'live', action: 'relist', actor_id: null }]);
  });

  it('sàn lỗi khi đọc trạng thái: nối lại vẫn 200, relisted 0, listing cũ giữ delisted', async () => {
    const s = `R-${randomUUID().slice(0, 6)}-X`;
    const { shopId, reconnect } = await disconnectedShop([s]);
    remote.set(s, { state: 'live' });
    getSkusFails = true;
    try {
      const res = await reconnect();
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ shop: { status: 'active' }, reconnect: { relisted: 0 } });
    } finally {
      getSkusFails = false;
    }
    expect(await rowsOf(shopId)).toEqual([expect.objectContaining({ status: 'delisted' })]);
  });
});

describe('việc đẩy đang giữ khi mất uỷ quyền (#219 AC-23)', () => {
  it('hai listing của cùng gian hàng bị giữ; nối lại thì cả hai việc chạy lại, không rơi việc nào', async () => {
    const company = await createCompany({ optionalModules: ['channel'] });
    const token = `tok-${randomUUID().slice(0, 12)}`;
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${company.ceo.token}`);
    const shopId = (await auth(app().post('/api/v1/channel/shops/lazada/token')).send({ accessToken: token })).body.shop.id as string;
    await testPool().query(`update channel.shops set status = 'needs_reauth', order_cutoff_at = now() where id = $1`, [shopId]);
    const boss = await jobBoss();
    await boss.createQueue('platform.held');
    await boss.createQueue(listingPushQueue.name);
    const listingIds = [randomUUID(), randomUUID()];
    for (const listingId of listingIds) {
      await boss.send('platform.held', { companyId: company.companyId, shopId, listingId, imageUrls: [], queue: listingPushQueue.name });
    }
    const res = await auth(app().post('/api/v1/channel/shops/lazada/token')).send({ accessToken: token });
    expect(res.body).toMatchObject({ shop: { status: 'active' }, reconnect: { jobsRun: 2 } });
    const jobs = await boss.findJobs<{ listingId: string }>(listingPushQueue.name, { data: { shopId } });
    expect(jobs.map((j) => j.data.listingId).sort()).toEqual([...listingIds].sort());
  });
});
