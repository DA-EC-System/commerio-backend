// Đồng bộ cây category của sàn (#400 lát 7, AC-S9): route xếp một lượt mỗi sàn, lượt chạy ghi cây, sàn cần token mượn
// phiên gian hàng `active` và lời gọi chỉ tính trần chung (`appOnly` giữ qua `forCompany` của lớp bọc token, A4).
// Dùng sàn `mock` (adapter giả đăng ký trong file): file khác không ghi cây của sàn này.
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { reservePlatformCall } from '#src/modules/channel/channel/repository/api-usage.ts';
import { findCategory } from '#src/modules/channel/channel/repository/platform-categories.ts';
import { runCategorySync } from '#src/modules/channel/channel/service/category-sync.ts';
import { callScope } from '#src/modules/channel/channel/service/marketplaces/call-scope.ts';
import { reserveOrThrow, type PlatformCategoryNode } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { inBackground, registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { activateShop, fakeAdapter } from './helpers.ts';

const app = testApp();
afterAll(() => resetAdapters());

// Ngày riêng ở tương lai xa để đếm `api_usage` không lẫn file khác.
const day = new Date(Date.UTC(3100 + randomInt(0, 90), randomInt(0, 12), randomInt(1, 28), 5));
const reserve = () => {
  const { companyId, background } = callScope();
  return reservePlatformCall('mock', 100_000, { companyId, background, companyMin: 1000, at: day });
};
const usage = async () => {
  const { rows } = await testPool().query<{ company_id: string | null; calls: number }>(
    'select company_id, calls from channel.api_usage where platform = $1 and day = $2::date',
    ['mock', day.toISOString().slice(0, 10)],
  );
  return rows;
};

const tok = randomUUID().slice(0, 6);
const tree: PlatformCategoryNode[] = [
  { externalId: `${tok}-r`, parentExternalId: null, name: 'Gốc', isLeaf: false, path: 'Gốc' },
  { externalId: `${tok}-a`, parentExternalId: `${tok}-r`, name: 'Lá A', isLeaf: true, path: 'Gốc > Lá A' },
];
const seen: { token: string | null; scope: ReturnType<typeof callScope> }[] = [];
function register(needToken: boolean) {
  registerAdapter(
    'mock',
    fakeAdapter({
      categoriesNeedToken: needToken,
      async getSeller(accessToken) {
        return { externalShopId: accessToken.slice(4), shopName: 'Shop mock', region: 'VN' };
      },
      async categoryTree(token) {
        seen.push({ token, scope: callScope() });
        await reserveOrThrow(reserve, 'Mock');
        return tree;
      },
    }),
  );
}

describe('route đồng bộ cây', () => {
  it('202 queued, bấm lần hai queued false; sàn không đọc được cây 422', async () => {
    register(false);
    const { ceo } = await createCompany({ optionalModules: [] });
    const post = (platform: string) =>
      request(app).post(`/api/v1/channel/platforms/${platform}/categories/sync`).set('Authorization', `Bearer ${ceo.token}`);
    const first = await post('mock');
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ queued: true });
    expect((await post('mock')).body).toEqual({ queued: false });

    registerAdapter('mock', fakeAdapter({}));
    const unsupported = await post('mock');
    expect(unsupported.status).toBe(422);
    expect(unsupported.body.type).toBe('/problems/marketplace_unsupported');
  });
});

describe('runCategorySync (AC-S9)', () => {
  it('sàn cần token mà không có gian hàng active: bỏ lượt, không gọi sàn', async () => {
    register(true);
    const n = seen.length;
    // Không đọc gian hàng thật: file khác có thể nối gian hàng `mock` active trên DB dùng chung (review BE1 P2-8).
    await inBackground(() => runCategorySync({ platform: 'mock' }, { borrowShop: async () => undefined }));
    expect(seen).toHaveLength(n);
  });

  it('mượn phiên gian hàng active: dòng công ty không tăng, dòng tổng tăng; ghi cây', async () => {
    register(true);
    const { ceo, companyId } = await createCompany({ optionalModules: [] });
    const access = `tok-${randomUUID().slice(0, 12)}`;
    const res = await request(app).post('/api/v1/channel/shops/mock/token').set('Authorization', `Bearer ${ceo.token}`).send({ accessToken: access });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    await activateShop(res.body.shops[0].shop.id);

    const before = await usage();
    await inBackground(() => runCategorySync({ platform: 'mock' }));
    expect(seen.at(-1)!.token).toBeTruthy();
    expect(seen.at(-1)!.scope).toEqual({ companyId: null, background: true });
    const after = await usage();
    const total = (rows: typeof before) => rows.find((r) => r.company_id === null)?.calls ?? 0;
    expect(total(after)).toBe(total(before) + 1);
    expect(after.find((r) => r.company_id === companyId)).toBeUndefined();
    expect(await findCategory('mock', `${tok}-a`)).toMatchObject({ isLeaf: true, path: 'Gốc > Lá A', pathSearch: 'goc > la a', status: 'active' });
  });

  it('sàn không cần token (Lazada) gọi không token, chỉ tính trần chung', async () => {
    register(false);
    await inBackground(() => runCategorySync({ platform: 'mock' }));
    expect(seen.at(-1)).toEqual({ token: null, scope: { companyId: null, background: true } });
  });
});
