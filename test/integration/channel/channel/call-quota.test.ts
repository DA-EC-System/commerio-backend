import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reservePlatformCall, usedCalls } from '#src/modules/channel/channel/repository/api-usage.ts';
import { runOrderPull } from '#src/modules/channel/channel/service/background.ts';
import { callScope } from '#src/modules/channel/channel/service/marketplaces/call-scope.ts';
import { reserveOrThrow } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { inBackground, registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { fakeAdapter } from './helpers.ts';

// Ngữ cảnh lời gọi sàn đi từ lớp gọi adapter tới bộ đếm (#215, Documents/21 §18.6.8): lời gọi qua phiên gian hàng tính
// vào phần của công ty sở hữu; request HTTP là bấm tay (dừng ở 90%), handler việc nền chạy tới 100%.
// Ngày riêng ở tương lai xa; trần chung = mức tối thiểu = 1000 nên phần của công ty luôn là 1000 dù sàn có bao nhiêu gian hàng.
const day = new Date(Date.UTC(2900 + randomInt(0, 90), randomInt(0, 12), randomInt(1, 28), 5));
const LIMIT = 1000;

// Sàn giả xin lượt như adapter thật (`reserveOrThrow` trước mỗi request) theo `callScope()` của lời gọi.
const reserve = () => {
  const { companyId, background } = callScope();
  return reservePlatformCall('lazada', LIMIT, { companyId, background, companyMin: LIMIT, at: day });
};
registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop hạn mức', region: 'VN' };
    },
    async listOrders() {
      await reserveOrThrow(reserve, 'Lazada');
      return { orders: [], nextCursor: null, safeUntil: null };
    },
    async getOrder() {
      throw new Error('không có đơn nào để đọc chi tiết');
    },
  }),
);
afterAll(() => resetAdapters());

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
let shopId: string;

/**
 * Đặt số lượt công ty đã dùng hôm `day`; dòng tổng của app về 0 để chỉ phần của công ty chặn (trần chung kiểm ở
 * `api-usage.test.ts`).
 */
async function setUsed(companyId: string, calls: number) {
  for (const [cid, n] of [[companyId, calls], [null, 0]] as const) {
    await testPool().query(
      `insert into channel.api_usage (platform, day, company_id, calls)
       values ('lazada', ($1::timestamptz at time zone 'Asia/Ho_Chi_Minh')::date, $2, $3)
       on conflict (platform, day, company_id) do update set calls = excluded.calls`,
      [day, cid, n],
    );
  }
}

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  const res = await app()
    .post('/api/v1/channel/shops/lazada/token')
    .set('Authorization', `Bearer ${company.ceo.token}`)
    .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  shopId = res.body.shop.id;
  await testPool().query(`update channel.shops set status = 'active', order_cutoff_at = now() where id = $1`, [shopId]);
});

describe('hạn mức gọi sàn theo công ty qua lớp gọi adapter (#215)', () => {
  it('bấm tay còn dưới 90% phần: gọi được, lượt tính vào công ty sở hữu gian hàng', async () => {
    await setUsed(company.companyId, 0);
    const res = await app().post(`/api/v1/channel/shops/${shopId}/orders/pull`).set('Authorization', `Bearer ${company.ceo.token}`);
    expect(res.status).toBe(200);
    expect(await usedCalls('lazada', company.companyId, day)).toBe(1);
  });

  it('bấm tay khi công ty đã dùng 90% phần: 503 marketplace_unavailable, platformCode company_call_limit', async () => {
    await setUsed(company.companyId, 900);
    const res = await app().post(`/api/v1/channel/shops/${shopId}/orders/pull`).set('Authorization', `Bearer ${company.ceo.token}`);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ type: '/problems/marketplace_unavailable', code: 'marketplace_unavailable', platformCode: 'company_call_limit' });
    expect(await usedCalls('lazada', company.companyId, day)).toBe(900);
  });

  it('việc nền vẫn chạy khi công ty đã dùng 90%, tới 100% thì dừng để pg-boss thử lại', async () => {
    await setUsed(company.companyId, 900);
    await expect(inBackground(() => runOrderPull({ companyId: company.companyId, shopId }))).resolves.toBeUndefined();
    expect(await usedCalls('lazada', company.companyId, day)).toBe(901);

    await setUsed(company.companyId, LIMIT);
    await expect(inBackground(() => runOrderPull({ companyId: company.companyId, shopId }))).rejects.toMatchObject({
      code: 'marketplace_unavailable',
      extensions: { platformCode: 'company_call_limit' },
    });
  });
});
