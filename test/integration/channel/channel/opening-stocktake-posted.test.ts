// #198 phần 2: phiếu kiểm kê đầu kỳ ghi sổ (`inventory.stocktake_posted`, Documents/21 §11.2) thì gian hàng thoát chế độ
// chờ kiểm kê, mốc kéo đơn = thời điểm đếm, bật đẩy tồn (§18.6.2). Sự kiện tự phát theo payload của Documents, chưa cần #245.
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EventPayload } from '#src/modules/core/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { onOpeningStocktakePosted } from '#src/modules/channel/channel/service/opening-stocktake.ts';
import { setStocktakePort } from '#src/modules/channel/channel/service/stocktake-port.ts';
import type { RemoteSku } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { type ListingVariant, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { fakeAdapter } from './helpers.ts';

const variant: ListingVariant = {
  id: randomUUID(),
  productId: randomUUID(),
  productName: 'Áo thun',
  sku: 'CMR-OS-1',
  categoryId: randomUUID(),
  attributesLabel: 'Trắng',
  archived: false,
  description: null,
  weightG: 200,
  lengthMm: 100,
  widthMm: 100,
  heightMm: 10,
};
const remote: RemoteSku[] = [
  { externalProductId: 'item-os', externalSkuId: 'sku-os', sellerSku: 'CMR-OS-1', title: 'Áo thun trắng', state: 'live', rejectReason: null, quantity: 4 },
];
const updatePriceQuantity = vi.fn(async (_t: string, items: readonly { externalSkuId: string }[]) =>
  items.map((i) => ({ externalSkuId: i.externalSkuId, ok: true as const })),
);

beforeAll(() => {
  setProductPort({
    variants: async (ids) => [variant].filter((v) => !ids || ids.includes(v.id)),
    standardPrices: async (ids) => new Map(ids.map((id) => [id, new Decimal(50000)])),
    availableOf: async (ids) => new Map(ids.map((id) => [id, 7])),
  });
  registerAdapter(
    'lazada',
    fakeAdapter({
      async getSeller(accessToken) {
        return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
      },
      getSkus: async (_t, sellerSkus) => remote.filter((r) => sellerSkus.includes(r.sellerSku)),
      updatePriceQuantity,
    }),
  );
  setStocktakePort({
    createOpeningStocktake: async () => ({ documentId: randomUUID(), number: `KK-${randomUUID().slice(0, 6)}`, created: true }),
    openingStocktakeStatusOf: async (ids) => new Map(ids.map((id) => [id, 'pending'])),
  });
});
afterAll(() => {
  resetAdapters();
  setProductPort(null);
  setStocktakePort();
});
afterEach(() => updatePriceQuantity.mockClear());

const app = () => request(testApp());
type Company = Awaited<ReturnType<typeof createCompany>>;
const auth = (c: Company) => ({ Authorization: `Bearer ${c.ceo.token}` });

/** Gian hàng đầu tiên của công ty thiết lập `stocktake`: active, chờ phiếu đầu kỳ. */
async function waitingShop(c: Company): Promise<{ shopId: string; documentId: string; number: string }> {
  const token = await app()
    .post('/api/v1/channel/shops/lazada/token')
    .set(auth(c))
    .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  expect(token.status).toBe(201);
  const shopId = token.body.shop.id as string;
  const res = await app().post(`/api/v1/channel/shops/${shopId}/setup`).set(auth(c)).send({ externalSkuIds: ['sku-os'], openingStock: 'stocktake' });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  // Lượt kéo đơn còn mở coi như đã xong, để chỉ còn chế độ chờ kiểm kê giữ tồn.
  await testPool().query('update channel.shops set open_orders_pulled_at = now() where id = $1', [shopId]);
  const { documentId, number } = res.body.shop.openingStocktake;
  return { shopId, documentId, number };
}

const counted = '2026-11-08T02:30:00.000Z';
const posted = (shopId: string, documentId: string, over: Partial<EventPayload<'inventory.stocktake_posted'>> = {}) => ({
  documentId,
  number: 'KK-000001',
  source: { type: 'shop_setup' as const, shopId },
  postedAt: '2026-11-08T03:00:00.000Z',
  countedAt: counted,
  lines: [{ variantId: variant.id, countedQty: 5, delta: 1 }],
  ...over,
});

async function shopRow(id: string) {
  const { rows } = await testPool().query(
    'select status, order_cutoff_at, opening_stocktake_id, opening_stocktake_number, version from channel.shops where id = $1',
    [id],
  );
  return rows[0];
}
async function listingSyncJobs(shopId: string): Promise<number> {
  const { rows } = await testPool().query(
    "select count(*)::int as n from pgboss.job where name = 'channel.listing_sync' and singleton_key = $1 and state = 'created'",
    [shopId],
  );
  return rows[0].n;
}

describe('phiếu đầu kỳ ghi sổ thì thoát chờ kiểm kê (#198 AC-11, AC-S4)', () => {
  it('AC-11a, AC-11b, AC-S4: openingStocktake null, mốc = countedAt, nhật ký hệ thống, xếp đồng bộ rồi đẩy tồn', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId, number } = await waitingShop(c);
    const before = await shopRow(shopId);
    const jobsBefore = await listingSyncJobs(shopId);

    await withCompany(c.companyId, () => onOpeningStocktakePosted(posted(shopId, documentId, { number })));

    const after = await shopRow(shopId);
    expect(after).toMatchObject({ status: 'active', opening_stocktake_id: null, opening_stocktake_number: null, version: before.version + 1 });
    expect(after.order_cutoff_at.toISOString()).toBe(counted);
    const one = await app().get(`/api/v1/channel/shops/${shopId}`).set(auth(c));
    expect(one.body).toMatchObject({ openingStocktake: null, orderCutoffAt: counted });

    const { rows: audit } = await testPool().query(
      "select actor_id, action, before, after from core.audit_logs where company_id = $1 and entity_type = 'channel.shops' and entity_id = $2",
      [c.companyId, shopId],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_id: null,
      action: 'update',
      before: { openingStocktakeId: documentId, openingStocktakeNumber: number },
      after: { orderCutoffAt: counted, openingStocktakeId: null, stocktakeNumber: number },
    });
    expect(new Date(audit[0].before.orderCutoffAt).getTime()).toBe(before.order_cutoff_at.getTime());

    expect(await listingSyncJobs(shopId)).toBe(Math.max(1, jobsBefore));
    // Lượt đồng bộ sau giờ đẩy cả tồn (trước đó giữ `stock_sync = pending`).
    const sync = await app().post(`/api/v1/channel/shops/${shopId}/listings/sync`).set(auth(c));
    expect(sync.status).toBe(200);
    expect(updatePriceQuantity).toHaveBeenCalledWith(expect.any(String), [expect.objectContaining({ externalSkuId: 'sku-os', quantity: 7 })]);
    const { rows } = await testPool().query('select stock_sync from channel.listings where shop_id = $1', [shopId]);
    expect(rows).toEqual([{ stock_sync: 'synced' }]);
  });

  it('AC-11d: thoát chờ thì công ty không còn bị chặn, gian hàng thứ hai thiết lập push được', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId } = await waitingShop(c);
    const second = await app()
      .post('/api/v1/channel/shops/lazada/token')
      .set(auth(c))
      .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
    const secondId = second.body.shop.id as string;
    const blocked = await app().post(`/api/v1/channel/shops/${secondId}/setup`).set(auth(c)).send({ externalSkuIds: [], openingStock: 'push' });
    expect(blocked.status).toBe(422);

    await withCompany(c.companyId, () => onOpeningStocktakePosted(posted(shopId, documentId)));

    const preview = await app().get(`/api/v1/channel/shops/${secondId}/setup`).set(auth(c));
    expect(preview.body.firstShopOfCompany).toBe(false);
    const ok = await app().post(`/api/v1/channel/shops/${secondId}/setup`).set(auth(c)).send({ externalSkuIds: [], openingStock: 'push' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('AC-11c: phiếu khác, nguồn null, gian hàng công ty khác, phát lại lần hai: không đổi gì', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const other = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId } = await waitingShop(c);
    const before = await shopRow(shopId);

    await withCompany(c.companyId, () => onOpeningStocktakePosted(posted(shopId, randomUUID())));
    await withCompany(c.companyId, () => onOpeningStocktakePosted(posted(shopId, documentId, { source: null })));
    // RLS: công ty khác không thấy gian hàng này
    await withCompany(other.companyId, () => onOpeningStocktakePosted(posted(shopId, documentId)));
    expect(await shopRow(shopId)).toEqual(before);

    await withCompany(c.companyId, () => onOpeningStocktakePosted(posted(shopId, documentId)));
    const once = await shopRow(shopId);
    await withCompany(c.companyId, () => onOpeningStocktakePosted(posted(shopId, documentId, { countedAt: '2026-11-09T00:00:00.000Z' })));
    expect(await shopRow(shopId)).toEqual(once);
    const { rows } = await testPool().query("select count(*)::int as n from core.audit_logs where entity_type = 'channel.shops' and entity_id = $1", [shopId]);
    expect(rows[0].n).toBe(1);
  });
});
