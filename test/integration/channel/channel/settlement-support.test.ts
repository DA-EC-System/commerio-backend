// Kéo quyết toán bỏ qua gian hàng của sàn chưa hỗ trợ (#401): cổng `settlementSource` thật của src/wiring.ts, sàn giả.
// Lazada giả có `getTransactions`, TikTok giả không có (như TikTok thật tới #252).
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { settlementSupported, shopsToSettle } from '#src/modules/channel/channel/service/settlement-port.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { stopJobs } from '#src/modules/core/platform/service/jobs/boss.ts';
import { openRun, pullAllShops } from '#src/modules/finance/finance/service/settlement-runs.ts';
import { logger } from '#src/shared/logger.ts';
import { createModuleContext } from '#src/wiring.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { activateShop, fakeAdapter } from './helpers.ts';

const seller = async (accessToken: string) => ({ externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' });
registerAdapter('lazada', fakeAdapter({ getSeller: seller, getTransactions: async () => [] }));
registerAdapter('tiktok', fakeAdapter({ getSeller: seller }));
afterAll(async () => {
  resetAdapters();
  await stopJobs();
});

let company: Awaited<ReturnType<typeof createCompany>>;
let lazadaShop: string;
let tiktokShop: string;
const connect = async (platform: string) => {
  const res = await request(testApp())
    .post(`/api/v1/channel/shops/${platform}/token`)
    .set('Authorization', `Bearer ${company.ceo.token}`)
    .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await activateShop(res.body.shop.id);
  return res.body.shop.id as string;
};
const runsOf = async (shopId: string) =>
  (await testPool().query('select status from finance.settlement_batches where shop_id = $1', [shopId])).rows;
const jobsOf = async (shopId: string) =>
  (await testPool().query("select 1 from pgboss.job where name = 'finance.settlement_run' and data->>'shopId' = $1", [shopId])).rowCount;

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  lazadaShop = await connect('lazada');
  tiktokShop = await connect('tiktok');
});

describe('cổng quyết toán của channel', () => {
  it('shopsToSettle chỉ có gian hàng của sàn kéo được quyết toán', async () => {
    const shops = (await shopsToSettle()).map((s) => s.shopId);
    expect(shops).toContain(lazadaShop);
    expect(shops).not.toContain(tiktokShop);
  });

  it('settlementSupported: Lazada có, TikTok không, gian hàng lạ hay của công ty khác không', async () => {
    expect(await settlementSupported(company.companyId, lazadaShop)).toBe(true);
    expect(await settlementSupported(company.companyId, tiktokShop)).toBe(false);
    expect(await settlementSupported(company.companyId, randomUUID())).toBe(false);
    expect(await settlementSupported((await createCompany()).companyId, lazadaShop)).toBe(false);
  });
});

describe('finance mở lần chạy', () => {
  it('nút Kéo quyết toán của gian hàng TikTok: 422 marketplace_unsupported, không có lần chạy, không có việc', async () => {
    const res = await request(testApp())
      .post('/api/v1/finance/settlement-runs')
      .set('Authorization', `Bearer ${company.ceo.token}`)
      .send({ shopId: tiktokShop });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.code).toBe('marketplace_unsupported');
    expect(await runsOf(tiktokShop)).toEqual([]);
    expect(await jobsOf(tiktokShop)).toBe(0);
  });

  it('gian hàng Lazada vẫn mở lần chạy và gửi việc như cũ', async () => {
    const run = await openRun(createModuleContext(), company.companyId, null, lazadaShop);
    expect(run.status).toBe('running');
    expect(await jobsOf(lazadaShop)).toBe(1);
  });

  it('vòng kéo 6 giờ không mở lần chạy cho gian hàng TikTok, không ghi lỗi', async () => {
    const error = vi.spyOn(logger, 'error');
    await pullAllShops(createModuleContext());
    expect(await runsOf(tiktokShop)).toEqual([]);
    expect(error.mock.calls.filter(([o]) => (o as { shopId?: string })?.shopId === tiktokShop)).toEqual([]);
    error.mockRestore();
  });
});
