// Tải lại SKU sàn chạy nền (#361; Documents/21 §18.3 `remote-skus`, `remote-skus/refresh`; §18.6.5). Việc nền
// `channel.remote_skus_refresh` chạy thẳng handler, không cần worker. Mỗi ca dùng gian hàng riêng.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callScope } from '#src/modules/channel/channel/service/marketplaces/call-scope.ts';
import { MarketplaceError, type RemoteSku } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { inBackground, registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { runRemoteSkusRefresh } from '#src/modules/channel/channel/service/remote-skus.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { activateShop, fakeAdapter } from './helpers.ts';

const remote: RemoteSku[] = [];
const newRemote = (extra: Partial<RemoteSku> = {}) => {
  const id = randomUUID().slice(0, 8);
  const r: RemoteSku = {
    externalProductId: `item-${id}`,
    externalSkuId: `sku-${id}`,
    sellerSku: `LZ-${id}`,
    title: `Cốc ${id}`,
    state: 'live',
    rejectReason: null,
    quantity: 3,
    ...extra,
  };
  remote.push(r);
  return r;
};
/** Hành vi sàn giả, từng ca đặt lại trong `finally`. */
const sàn = {
  listSkus: 0,
  changed: 0,
  fullError: null as MarketplaceError | null,
  changedResult: [] as RemoteSku[],
  /** `callScope().background` lúc đọc trọn (lượt Tải lại tính như bấm tay, A4). */
  background: [] as boolean[],
};
registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
    },
    listSkus: async () => {
      sàn.listSkus++;
      sàn.background.push(callScope().background);
      if (sàn.fullError) throw sàn.fullError;
      return remote;
    },
    listSkusChanged: async () => {
      sàn.changed++;
      return sàn.changedResult;
    },
  }),
);
afterAll(() => resetAdapters());

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
const as = (r: request.Test, token: string) => r.set('Authorization', `Bearer ${token}`);

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
});

/** Gian hàng mới của công ty, `active`, chưa có bản sao. */
async function freshShop(): Promise<string> {
  const res = await as(app().post('/api/v1/channel/shops/lazada/token'), company.ceo.token).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  const id = res.body.shop.id as string;
  await activateShop(id);
  return id;
}
const LAST = { attempt: 2, lastAttempt: true };
const FIRST = { attempt: 1, lastAttempt: false };
/** Chạy việc nền như worker (bọc `inBackground` như `workChannelQueue`). */
const runJob = (shopId: string, attempt = LAST) => inBackground(() => runRemoteSkusRefresh({ companyId: company.companyId, shopId }, attempt));
/** Đặt lượt chờ như POST đã xếp việc. */
const request_ = (shopId: string, at = "now()") =>
  testPool().query(`update channel.shops set remote_skus_refresh_requested_at = ${at} where id = $1`, [shopId]);
/** Gian hàng đã có bản sao (một lượt Tải lại chạy xong). */
async function withSnapshot(): Promise<string> {
  const id = await freshShop();
  await request_(id);
  await runJob(id);
  return id;
}
const shopRow = async (id: string) =>
  (
    await testPool().query(
      `select remote_skus_synced_at as synced, remote_skus_refresh_requested_at as requested, remote_skus_full_failed_at as failed,
              remote_skus_full_error as error, remote_skus_full_failures as failures
         from channel.shops where id = $1`,
      [id],
    )
  ).rows[0];
const snapshotIds = async (id: string) =>
  (await testPool().query<{ id: string }>('select external_sku_id as id from channel.remote_skus where shop_id = $1', [id])).rows.map((r) => r.id);

describe('việc nền `channel.remote_skus_refresh` (#361)', () => {
  it('AC-4: đọc trọn được → bản sao có SKU mới, `syncedAt` mới, xoá lượt chờ và lỗi cũ', async () => {
    const id = await freshShop();
    const r = newRemote();
    await testPool().query(
      "update channel.shops set remote_skus_refresh_requested_at = now(), remote_skus_full_failed_at = now() - interval '20 minutes', remote_skus_full_error = $2 where id = $1",
      [id, JSON.stringify({ code: 'marketplace_rejected', platformCode: 'incomplete_list', message: 'Sàn từ chối yêu cầu' })],
    );
    await runJob(id, FIRST);
    expect(await snapshotIds(id)).toContain(r.externalSkuId);
    const row = await shopRow(id);
    expect(row.synced).not.toBeNull();
    expect(row).toMatchObject({ requested: null, failed: null, error: null });
  });

  it('A4: lượt Tải lại chạy trong việc nền vẫn tính hạn mức như bấm tay', async () => {
    const id = await freshShop();
    sàn.background.length = 0;
    await request_(id);
    await runJob(id);
    expect(sàn.background).toEqual([false]);
  });

  it('AC-6: đọc theo giờ sửa trước, nên SKU mới vào bản sao dù đọc trọn lỗi; lần đầu lỗi thì ném để pg-boss thử lại sau 30 giây', async () => {
    const id = await withSnapshot();
    await testPool().query("update channel.shops set remote_skus_synced_at = now() - interval '2 minutes' where id = $1", [id]);
    const added = newRemote();
    sàn.changedResult = [added];
    sàn.fullError = new MarketplaceError('rejected', 'incomplete_list', 'Sàn trả thiếu');
    try {
      await request_(id);
      const changedBefore = sàn.changed;
      await expect(runJob(id, FIRST)).rejects.toMatchObject({ code: 'marketplace_rejected' });
      expect(sàn.changed).toBe(changedBefore + 1);
      expect(await snapshotIds(id)).toContain(added.externalSkuId);
      // Chưa phải lần cuối: chưa ghi lỗi, lượt vẫn chạy.
      expect(await shopRow(id)).toMatchObject({ failed: null, error: null });
      expect((await shopRow(id)).requested).not.toBeNull();
    } finally {
      sàn.changedResult = [];
      sàn.fullError = null;
    }
  });

  it('AC-5: lần cuối vẫn lỗi `incomplete_list` → ghi giờ lỗi, mã lỗi (không câu thô của sàn), xoá lượt chờ, không ném; không tính vào giãn định kỳ', async () => {
    const id = await withSnapshot();
    await testPool().query("update channel.shops set remote_skus_synced_at = now() - interval '2 minutes' where id = $1", [id]);
    sàn.fullError = new MarketplaceError('rejected', 'incomplete_list', 'Sàn trả thiếu https://api.lazada.vn/?access_token=bí-mật');
    try {
      await request_(id);
      await expect(runJob(id, LAST)).resolves.toBeUndefined();
    } finally {
      sàn.fullError = null;
    }
    const row = await shopRow(id);
    expect(row.failed).not.toBeNull();
    expect(row.requested).toBeNull();
    expect(row.failures).toBe(0);
    expect(row.error).toEqual({ code: 'marketplace_rejected', platformCode: 'incomplete_list', message: 'Sàn từ chối yêu cầu' });
    expect(JSON.stringify(row.error)).not.toContain('access_token');
  });

  it('Hết hạn mức ngày (`daily_call_limit`) không thử lại: ghi lỗi ngay ở lần đầu', async () => {
    const id = await freshShop();
    sàn.fullError = new MarketplaceError('unavailable', 'daily_call_limit', 'Hết hạn mức');
    try {
      await request_(id);
      await expect(runJob(id, FIRST)).resolves.toBeUndefined();
    } finally {
      sàn.fullError = null;
    }
    expect((await shopRow(id)).error).toMatchObject({ code: 'marketplace_unavailable', platformCode: 'daily_call_limit' });
  });

  it('Gian hàng ngắt trong lúc việc chờ → ghi `shop_not_connected`, xoá lượt chờ, không gọi sàn, không ném', async () => {
    const id = await freshShop();
    await request_(id);
    await testPool().query("update channel.shops set status = 'disconnected', access_token_enc = null where id = $1", [id]);
    const before = sàn.listSkus;
    await expect(runJob(id, FIRST)).resolves.toBeUndefined();
    expect(sàn.listSkus).toBe(before);
    expect(await shopRow(id)).toMatchObject({ requested: null, error: { code: 'shop_not_connected' } });
  });

  it('Không có lượt chờ (việc gửi lại, đã xong) → không gọi sàn', async () => {
    const id = await freshShop();
    const before = sàn.listSkus;
    await runJob(id);
    expect(sàn.listSkus).toBe(before);
  });

  it('Lượt định kỳ đã đọc trọn sau lúc bấm → không đọc lại, xoá lượt chờ', async () => {
    const id = await withSnapshot();
    await request_(id, "now() - interval '1 minute'");
    const before = sàn.listSkus;
    await runJob(id);
    expect(sàn.listSkus).toBe(before);
    expect((await shopRow(id)).requested).toBeNull();
  });
});
