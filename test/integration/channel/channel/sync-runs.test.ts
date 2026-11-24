// Kết quả lượt đồng bộ do người bấm (Documents/21 §18 "Kết quả lượt đồng bộ"; thiết kế trang-san-pham-tab/design/v2.html
// Màn 2): POST trả `runId`, việc nền nhận lượt, đẩy theo lô, ghi tiến độ, thành công, lỗi kèm chỗ sửa; GET theo id, latest.
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { stopJobs } from '#src/modules/core/platform/service/jobs/boss.ts';
import { ListingList, ListingSyncResult, SyncRun } from '#src/modules/channel/channel/api/schemas.ts';
import { runListingSync } from '#src/modules/channel/channel/service/background.ts';
import type { PerSkuResult, RemoteSku } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { type ListingVariant, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { activateShop, fakeAdapter } from './helpers.ts';

const variant = (sku: string, productName: string, attributesLabel: string): ListingVariant => ({
  id: randomUUID(),
  productId: randomUUID(),
  productName,
  sku,
  attributesLabel,
  productCode: 'SP-TEST',
  groupId: 'GROUP-TEST',
  attributes: [],
  archived: false,
  businessStatus: 'selling',
  description: null,
  weightG: 200,
  lengthMm: 100,
  widthMm: 100,
  heightMm: 10,
});
const ok = variant(`OK-${randomUUID().slice(0, 6)}`, 'Áo thun', 'Đen / M');
const rejected = variant(`RJ-${randomUUID().slice(0, 6)}`, 'Áo thun', 'Trắng / M');
const noPrice = variant(`NP-${randomUUID().slice(0, 6)}`, 'Áo thun', 'Đen / L');
const notCounted = variant(`NC-${randomUUID().slice(0, 6)}`, 'Son lì', 'Hồng');
const all = [ok, rejected, noPrice, notCounted];

const port = {
  variants: async (ids?: readonly string[]) => all.filter((v) => !ids || ids.includes(v.id)),
  standardPrices: async (ids: readonly string[]) => new Map(ids.map((id) => [id, id === noPrice.id ? null : new Decimal(99000)])),
  productImageUrls: async () => new Map<string, string[]>(),
  availableOf: async (ids: readonly string[]) => new Map(ids.map((id) => [id, 5])),
  countedOf: async (ids: readonly string[]) => new Set(ids.filter((id) => id !== notCounted.id)),
};
setProductPort(port);

const updatePriceQuantity = vi.fn(async (_t: string, items: readonly { externalSkuId: string }[]) =>
  items.map((i): PerSkuResult =>
    i.externalSkuId === `sku-${rejected.sku}`
      ? { externalSkuId: i.externalSkuId, ok: false, code: 'E0004', message: 'Product Status not online' }
      : { externalSkuId: i.externalSkuId, ok: true },
  ),
);
registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
    },
    async getSkus(_t, sellerSkus): Promise<RemoteSku[]> {
      return sellerSkus.map((s) => ({ externalProductId: `item-${s}`, externalSkuId: `sku-${s}`, sellerSku: s, title: s, state: 'live', rejectReason: null, quantity: 0 }));
    },
    updatePriceQuantity,
  }),
);
afterAll(async () => {
  resetAdapters();
  setProductPort(null);
  await stopJobs();
});

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
let shopId: string;
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${company.ceo.token}`);

beforeAll(async () => {
  company = await createCompany({ optionalModules: [] });
  const res = await auth(app().post('/api/v1/channel/shops/lazada/token')).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  shopId = res.body.shop.id;
  await activateShop(shopId);
  for (const v of all) {
    await testPool().query(
      `insert into channel.listings (company_id, shop_id, variant_id, external_product_id, external_sku_id, seller_sku, status, stock_sync, price_sync)
       values ($1, $2, $3, $4, $5, $6, 'live', 'pending', 'pending')`,
      [company.companyId, shopId, v.id, `item-${v.sku}`, `sku-${v.sku}`, v.sku],
    );
  }
});

const getRun = async (runId: string) => {
  const res = await auth(app().get(`/api/v1/channel/shops/${shopId}/listings/sync-runs/${runId}`));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return SyncRun.parse(res.body);
};

describe('lượt đồng bộ do người bấm', () => {
  it('POST trả runId (bấm hai lần cùng lượt chờ); việc nền ghi tiến độ, số thành công, lỗi kèm câu, câu sàn, chỗ sửa, tên sản phẩm', async () => {
    const first = await auth(app().post(`/api/v1/channel/shops/${shopId}/listings/sync`));
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    const { runId } = ListingSyncResult.parse(first.body);
    const again = ListingSyncResult.parse((await auth(app().post(`/api/v1/channel/shops/${shopId}/listings/sync`))).body);
    expect(again.runId).toBe(runId);
    expect(await getRun(runId)).toMatchObject({ status: 'queued', progress: { processed: 0, total: null }, startedAt: null });

    await runListingSync(port, { companyId: company.companyId, shopId });

    const run = await getRun(runId);
    expect(run).toMatchObject({ status: 'done', progress: { processed: 4, total: 4 }, succeeded: 1, failed: 3, error: null });
    const byCode = Object.fromEntries(run.errors.map((e) => [e.code, e]));
    expect(byCode.E0004).toMatchObject({
      sku: rejected.sku,
      variantId: rejected.id,
      productId: rejected.productId,
      productName: 'Áo thun',
      attributesLabel: 'Trắng / M',
      message: 'Sàn từ chối cập nhật tồn',
      platformMessage: 'Product Status not online',
      fix: null,
    });
    expect(byCode.price_missing).toMatchObject({ variantId: noPrice.id, fix: 'variant_price', platformMessage: null });
    expect(byCode.stock_not_counted).toMatchObject({ variantId: notCounted.id, fix: 'stocktake', platformMessage: null });
    expect(byCode.stock_not_counted!.message).toContain('Chưa có số tồn');

    // Quay lại trang: latest là lượt vừa xong; dòng listing có giờ lần thử lỗi, lần thành công giữ ở lastPushedAt.
    const latest = await auth(app().get(`/api/v1/channel/shops/${shopId}/listings/sync-runs/latest`));
    expect(SyncRun.parse(latest.body).id).toBe(runId);
    const rows = ListingList.parse((await auth(app().get(`/api/v1/channel/shops/${shopId}/listings`))).body).items;
    const row = (id: string) => rows.find((r) => r.variantId === id)!;
    expect(row(rejected.id).lastSyncFailedAt).not.toBeNull();
    expect(row(ok.id)).toMatchObject({ lastSyncFailedAt: null, listing: { lastPushedAt: expect.any(String) } });
  });

  it('lượt quá 30 phút chưa xong đọc ra failed run_stale; lượt gian hàng khác, id sai dạng: 404', async () => {
    const { rows } = await testPool().query<{ id: string }>(
      `insert into channel.listing_sync_runs (company_id, shop_id, status, requested_at, started_at)
       values ($1, $2, 'running', now() - interval '2 hours', now() - interval '2 hours') returning id`,
      [company.companyId, shopId],
    );
    expect(await getRun(rows[0]!.id)).toMatchObject({ status: 'failed', error: { code: 'run_stale' } });
    expect((await auth(app().get(`/api/v1/channel/shops/${shopId}/listings/sync-runs/khong-phai-uuid`))).status).toBe(404);
    const other = await createCompany({ optionalModules: [] });
    const res = await app().get(`/api/v1/channel/shops/${shopId}/listings/sync-runs/${rows[0]!.id}`).set('Authorization', `Bearer ${other.ceo.token}`);
    expect(res.status).toBe(404);
  });

  it('lượt queued quá 30 phút: POST ghi lượt cũ thành failed run_stale rồi tạo lượt mới, không dùng lại', async () => {
    const { rows } = await testPool().query<{ id: string }>(
      `insert into channel.listing_sync_runs (company_id, shop_id, status, requested_at)
       values ($1, $2, 'queued', now() - interval '2 hours') returning id`,
      [company.companyId, shopId],
    );
    const old = rows[0]!.id;
    const res = await auth(app().post(`/api/v1/channel/shops/${shopId}/listings/sync`));
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const { runId } = ListingSyncResult.parse(res.body);
    expect(runId).not.toBe(old);
    expect(await getRun(runId)).toMatchObject({ status: 'queued', error: null });
    const stored = await testPool().query<{ status: string; error: { code: string } | null; finished_at: Date | null }>(
      'select status, error, finished_at from channel.listing_sync_runs where id = $1',
      [old],
    );
    expect(stored.rows[0]).toMatchObject({ status: 'failed', error: { code: 'run_stale' }, finished_at: expect.any(Date) });
    // Dọn lượt chờ cho ca sau.
    await runListingSync(port, { companyId: company.companyId, shopId });
  });

  it('gian hàng không còn active lúc việc chạy: lượt chờ thành failed shop_not_connected', async () => {
    const { runId } = ListingSyncResult.parse((await auth(app().post(`/api/v1/channel/shops/${shopId}/listings/sync`))).body);
    await testPool().query("update channel.shops set status = 'needs_reauth', orders_pulled_ok_at = null where id = $1", [shopId]);
    try {
      await runListingSync(port, { companyId: company.companyId, shopId });
    } finally {
      await activateShop(shopId);
    }
    expect(await getRun(runId)).toMatchObject({ status: 'failed', error: { code: 'shop_not_connected' } });
  });
});

describe('số của lượt đồng bộ', () => {
  const connect = async (c: Awaited<ReturnType<typeof createCompany>>) => {
    const res = await app()
      .post('/api/v1/channel/shops/lazada/token')
      .set('Authorization', `Bearer ${c.ceo.token}`)
      .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await activateShop(res.body.shop.id);
    return res.body.shop.id as string;
  };
  const sync = async (c: Awaited<ReturnType<typeof createCompany>>, id: string) => {
    const res = await app().post(`/api/v1/channel/shops/${id}/listings/sync`).set('Authorization', `Bearer ${c.ceo.token}`);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    return ListingSyncResult.parse(res.body).runId;
  };
  const runOf = async (c: Awaited<ReturnType<typeof createCompany>>, id: string, runId: string) =>
    SyncRun.parse((await app().get(`/api/v1/channel/shops/${id}/listings/sync-runs/${runId}`).set('Authorization', `Bearer ${c.ceo.token}`)).body);

  it('gian hàng không có listing nào phải đẩy: lượt done với total = 0, không để null', async () => {
    const c = await createCompany({ optionalModules: [] });
    const id = await connect(c);
    const runId = await sync(c, id);
    await runListingSync(port, { companyId: c.companyId, shopId: id });
    expect(await runOf(c, id, runId)).toMatchObject({ status: 'done', progress: { processed: 0, total: 0 }, succeeded: 0, failed: 0 });
  });

  it('listing lệch version giữa lúc gọi sàn và lúc ghi: không tính thành công, trừ khỏi total, processed vẫn bằng total', async () => {
    const c = await createCompany({ optionalModules: [] });
    const id = await connect(c);
    const a = variant(`VA-${randomUUID().slice(0, 6)}`, 'Mũ', 'Đỏ');
    const b = variant(`VB-${randomUUID().slice(0, 6)}`, 'Mũ', 'Xanh');
    all.push(a, b);
    try {
      for (const v of [a, b]) {
        await testPool().query(
          `insert into channel.listings (company_id, shop_id, variant_id, external_product_id, external_sku_id, seller_sku, status, stock_sync, price_sync)
           values ($1, $2, $3, $4, $5, $6, 'live', 'pending', 'pending')`,
          [c.companyId, id, v.id, `item-${v.sku}`, `sku-${v.sku}`, v.sku],
        );
      }
      // Tồn đổi giữa lúc đọc và lúc ghi (vd đơn mới đánh dấu lại pending): `version` của listing b tăng trong lúc gọi sàn.
      updatePriceQuantity.mockImplementationOnce(async (_t, items) => {
        await testPool().query('update channel.listings set version = version + 1 where shop_id = $1 and variant_id = $2', [id, b.id]);
        return items.map((i) => ({ externalSkuId: i.externalSkuId, ok: true }));
      });
      const runId = await sync(c, id);
      await runListingSync(port, { companyId: c.companyId, shopId: id });
      expect(await runOf(c, id, runId)).toMatchObject({ status: 'done', progress: { processed: 1, total: 1 }, succeeded: 1, failed: 0 });
      const { rows } = await testPool().query<{ stock_sync: string }>(
        'select stock_sync from channel.listings where shop_id = $1 and variant_id = $2',
        [id, b.id],
      );
      expect(rows[0]!.stock_sync).toBe('pending');
    } finally {
      all.splice(all.indexOf(a), 2);
    }
  });
});
