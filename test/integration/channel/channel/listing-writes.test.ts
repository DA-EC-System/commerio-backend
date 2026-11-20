// Lớp ghi listing (#216 cách A, spec 5.5): mọi lần ghi đổi `status`, `stockSync`, `priceSync` phát
// `channel.listing_sync_changed` mang giá trị sau, cùng giao dịch; đổi khác không phát; ngắt gian hàng không phát (D12).
// Bộ ba trước đọc dưới khoá dòng (không dùng `RETURNING old.*` của PG18): chạy thêm trên PG17 bằng
// `TEST_PG_IMAGE=pgvector/pgvector:pg17` (AC13).
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import {
  delistForDisconnect,
  failPushingForDisconnect,
  insertListing,
  markStockPendingIds,
  markStockPendingRows,
  updateListing,
} from '#src/modules/channel/channel/service/listing-writes.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { raceBehindLock } from '../../helpers/locks.ts';
import { activateShop, fakeAdapter } from './helpers.ts';

registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
    },
  }),
);
afterAll(() => resetAdapters());

let company: Awaited<ReturnType<typeof createCompany>>;

beforeAll(async () => {
  company = await createCompany({ optionalModules: [] });
});

/** Gian hàng `active` mới cho mỗi ca: sự kiện đọc theo gian hàng không lẫn giữa các ca. */
async function newShop(): Promise<string> {
  const res = await request(testApp())
    .post('/api/v1/channel/shops/lazada/token')
    .set('Authorization', `Bearer ${company.ceo.token}`)
    .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  const shopId = res.body.shop.id as string;
  await activateShop(shopId);
  return shopId;
}

interface Seed {
  status?: string;
  stockSync?: 'synced' | 'pending' | 'error';
  priceSync?: 'synced' | 'pending' | 'error';
  variantId?: string;
}

/** Listing ghi thẳng bằng role chủ bảng (như `liveListing` của `stock-push.test.ts`). */
async function seedListing(shopId: string, s: Seed = {}): Promise<{ id: string; version: number; variantId: string }> {
  const variantId = s.variantId ?? randomUUID();
  const sku = `LW-${randomUUID().slice(0, 8)}`;
  const { rows } = await testPool().query<{ id: string; version: number }>(
    `insert into channel.listings (company_id, shop_id, variant_id, seller_sku, status, external_product_id, external_sku_id, stock_sync, price_sync)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id, version`,
    [company.companyId, shopId, variantId, sku, s.status ?? 'live', `item-${sku}`, `sku-${sku}`, s.stockSync ?? 'synced', s.priceSync ?? 'synced'],
  );
  return { ...rows[0]!, variantId };
}

const run = <T>(fn: () => Promise<T>) => withCompany(company.companyId, fn);

async function events(shopId: string, listingId?: string) {
  const { rows } = await testPool().query<{ key: string; payload: Record<string, unknown> }>(
    `select key, payload from core.outbox_messages where type = 'channel.listing_sync_changed' and key = $1 order by id`,
    [shopId],
  );
  for (const r of rows) expect(r.key).toBe(shopId);
  return rows.map((r) => r.payload).filter((p) => !listingId || p.listingId === listingId);
}

describe('lớp ghi listing phát channel.listing_sync_changed (#216 AC8)', () => {
  it('updateListing đổi priceSync: một sự kiện mang bộ ba sau', async () => {
    const shopId = await newShop();
    const l = await seedListing(shopId);
    const row = await run(() => updateListing(l.id, { version: l.version }, { priceSync: 'pending' }));
    expect(row).toMatchObject({ id: l.id, priceSync: 'pending', version: l.version + 1 });
    expect(await events(shopId)).toEqual([{ shopId, listingId: l.id, stockSync: 'synced', priceSync: 'pending', status: 'live' }]);
  });

  it('updateListing chỉ đổi trường khác (listedPrice): không phát', async () => {
    const shopId = await newShop();
    const l = await seedListing(shopId);
    const row = await run(() => updateListing(l.id, { version: l.version }, { listedPrice: '150000' }));
    expect(row?.version).toBe(l.version + 1);
    expect(await events(shopId)).toEqual([]);
  });

  it('updateListing trượt version: trả undefined, không phát', async () => {
    const shopId = await newShop();
    const l = await seedListing(shopId);
    expect(await run(() => updateListing(l.id, { version: l.version + 5 }, { priceSync: 'pending' }))).toBeUndefined();
    expect(await events(shopId)).toEqual([]);
  });

  it('updateListing kèm status sai: trả undefined, không phát', async () => {
    const shopId = await newShop();
    const l = await seedListing(shopId);
    expect(await run(() => updateListing(l.id, { version: l.version, status: 'hidden' }, { status: 'live', priceSync: 'pending' }))).toBeUndefined();
    expect(await events(shopId)).toEqual([]);
  });

  it('updateListing chuyển trạng thái đúng: phát theo trạng thái mới', async () => {
    const shopId = await newShop();
    const l = await seedListing(shopId);
    await run(() => updateListing(l.id, { version: l.version, status: 'live' }, { status: 'hidden', hiddenBy: 'platform' }));
    expect(await events(shopId)).toEqual([{ shopId, listingId: l.id, stockSync: 'synced', priceSync: 'synced', status: 'hidden' }]);
  });

  it('markStockPendingRows: synced → pending phát; error giữ error và pending giữ pending không phát; trả đủ id gian hàng', async () => {
    const shopId = await newShop();
    const synced = await seedListing(shopId);
    const failing = await seedListing(shopId, { stockSync: 'error' });
    const waiting = await seedListing(shopId, { stockSync: 'pending' });
    const shops = await run(() => markStockPendingRows([synced.variantId, failing.variantId, waiting.variantId], ['live']));
    expect(shops).toEqual([shopId]);
    expect(await events(shopId)).toEqual([{ shopId, listingId: synced.id, stockSync: 'pending', priceSync: 'synced', status: 'live' }]);
    const { rows } = await testPool().query<{ id: string; stock_sync: string; version: number }>(
      'select id, stock_sync, version from channel.listings where id = any($1)',
      [[synced.id, failing.id, waiting.id]],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(failing.id)).toMatchObject({ stock_sync: 'error', version: failing.version + 1 });
    expect(byId.get(waiting.id)).toMatchObject({ stock_sync: 'pending', version: waiting.version + 1 });
  });

  it('markStockPendingRows: N listing synced → N sự kiện, theo thứ tự id; trạng thái ngoài danh sách không chạm', async () => {
    const shopId = await newShop();
    const variantId = randomUUID();
    const shop2 = await newShop();
    const a = await seedListing(shopId, { variantId });
    const b = await seedListing(shop2, { variantId });
    const c = await seedListing(shopId, { status: 'delisted' });
    const shops = await run(() => markStockPendingRows([variantId, c.variantId], ['live']));
    expect([...shops].sort()).toEqual([shopId, shop2].sort());
    expect(await events(shopId)).toEqual([{ shopId, listingId: a.id, stockSync: 'pending', priceSync: 'synced', status: 'live' }]);
    expect(await events(shop2)).toEqual([{ shopId: shop2, listingId: b.id, stockSync: 'pending', priceSync: 'synced', status: 'live' }]);
  });

  it('markStockPendingIds: synced → pending phát một sự kiện mỗi listing', async () => {
    const shopId = await newShop();
    const a = await seedListing(shopId);
    const b = await seedListing(shopId);
    await run(() => markStockPendingIds([a.id, b.id]));
    const got = await events(shopId);
    expect(got).toHaveLength(2);
    expect(got).toEqual(
      expect.arrayContaining([
        { shopId, listingId: a.id, stockSync: 'pending', priceSync: 'synced', status: 'live' },
        { shopId, listingId: b.id, stockSync: 'pending', priceSync: 'synced', status: 'live' },
      ]),
    );
    expect(got.map((e) => e.listingId)).toEqual([a.id, b.id].sort());
    const { rows } = await testPool().query<{ platform_stock: number }>('select platform_stock from channel.listings where id = $1', [a.id]);
    expect(rows[0]!.platform_stock).toBe(0);
  });

  it('insertListing: một sự kiện theo giá trị vừa chèn', async () => {
    const shopId = await newShop();
    const sku = `LW-${randomUUID().slice(0, 8)}`;
    const row = await run(() =>
      insertListing({
        companyId: company.companyId,
        shopId,
        variantId: randomUUID(),
        sellerSku: sku,
        status: 'under_review',
        externalProductId: `item-${sku}`,
        externalSkuId: `sku-${sku}`,
        stockSync: 'pending',
        priceSync: 'pending',
      }),
    );
    expect(await events(shopId)).toEqual([{ shopId, listingId: row.id, stockSync: 'pending', priceSync: 'pending', status: 'under_review' }]);
  });

  it('delistForDisconnect, failPushingForDisconnect: đổi trạng thái nhưng không phát (D12)', async () => {
    const shopId = await newShop();
    const live = await seedListing(shopId);
    const pushing = await seedListing(shopId, { status: 'pushing' });
    await run(async () => {
      expect((await delistForDisconnect(shopId)).map((r) => r.id)).toEqual([live.id]);
      expect((await failPushingForDisconnect(shopId)).map((r) => r.id)).toEqual([pushing.id]);
    });
    const { rows } = await testPool().query<{ id: string; status: string }>('select id, status from channel.listings where shop_id = $1', [shopId]);
    expect(new Map(rows.map((r) => [r.id, r.status]))).toEqual(
      new Map([
        [live.id, 'delisted'],
        [pushing.id, 'push_failed'],
      ]),
    );
    expect(await events(shopId)).toEqual([]);
  });
});

describe('ghi đua cùng listing (#216 spec 5.6)', () => {
  it('lượt kia vừa ghi và tăng version: updateListing theo version cũ trả undefined, không phát, không treo', async () => {
    const shopId = await newShop();
    const l = await seedListing(shopId);
    const result = await raceBehindLock(
      (holder) => holder.query(`update channel.listings set price_sync = 'pending', version = version + 1 where id = $1`, [l.id]),
      1,
      () => run(() => updateListing(l.id, { version: l.version }, { stockSync: 'pending' })),
    );
    expect(result).toBeUndefined();
    expect(await events(shopId)).toEqual([]);
  });

  it('bộ ba trước đọc sau khoá: lượt kia vừa đánh pending thì lượt chờ không thấy đổi, không phát', async () => {
    const shopId = await newShop();
    const l = await seedListing(shopId);
    // Lượt giữ khoá đánh stock_sync = pending rồi commit (ngoài lớp ghi: không phát). Đọc bộ ba trước khi chờ khoá thì
    // lượt chờ thấy synced → pending và phát thừa.
    await raceBehindLock(
      (holder) => holder.query(`update channel.listings set stock_sync = 'pending', version = version + 1 where id = $1`, [l.id]),
      1,
      () => run(() => markStockPendingIds([l.id])),
    );
    expect(await events(shopId)).toEqual([]);
  });

  it('lượt chờ thấy phần lượt kia đã ghi, phát bộ ba sau gồm cả phần đó', async () => {
    const shopId = await newShop();
    const l = await seedListing(shopId);
    await raceBehindLock(
      (holder) => holder.query(`update channel.listings set price_sync = 'pending', version = version + 1 where id = $1`, [l.id]),
      1,
      () => run(() => markStockPendingIds([l.id])),
    );
    expect(await events(shopId)).toEqual([{ shopId, listingId: l.id, stockSync: 'pending', priceSync: 'pending', status: 'live' }]);
  });
});
