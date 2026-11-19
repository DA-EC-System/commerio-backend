// Cờ `allowShrink` của "Đồng bộ ngay" (#400, Thành chốt 19/11/2026): chỉ quản trị nền tảng gửi được, người khác 403
// `forbidden`; cờ đi theo việc xuống `syncTree`, lượt bị chặn vì cây thiếu ghi log `error` kèm số node bỏ và tổng node.
// Dùng sàn `shopee` (adapter giả trong file) để cây của file khác không tính vào ngưỡng thiếu.
import { randomInt } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { CategoryTreeShrunkError, findCategory } from '#src/modules/channel/channel/repository/platform-categories.ts';
import { runCategorySync } from '#src/modules/channel/channel/service/category-sync.ts';
import type { PlatformCategoryNode } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { logger } from '#src/shared/logger.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { fakeAdapter } from './helpers.ts';

const app = testApp();
afterAll(() => resetAdapters());
afterEach(() => vi.restoreAllMocks());

// Mã node là số (BE1 ép `externalId` số).
const base = randomInt(1_000_000, 9_000_000) * 1000;
const id = (i: number | 'r') => String(i === 'r' ? base : base + 1 + i);
const nodes = (n: number): PlatformCategoryNode[] => [
  { externalId: id('r'), parentExternalId: null, name: 'Gốc', isLeaf: false, path: 'Gốc' },
  ...Array.from({ length: n }, (_, i) => ({
    externalId: id(i),
    parentExternalId: id('r'),
    name: `Lá ${i}`,
    isLeaf: true,
    path: `Gốc > Lá ${i}`,
  })),
];
let tree = nodes(120);
registerAdapter('shopee', fakeAdapter({ categoriesNeedToken: false, categoryTree: async () => tree }));

const post = (token: string, body?: object) => {
  const req = request(app).post('/api/v1/channel/platforms/shopee/categories/sync').set('Authorization', `Bearer ${token}`);
  return body ? req.send(body) : req;
};
const queued = async () =>
  (await testPool().query<{ data: { allowShrink?: boolean } }>("select data from pgboss.job where name = 'channel.category_sync' and data->>'platform' = 'shopee' and state = 'created'")).rows;

describe('route đồng bộ cây: allowShrink', () => {
  it('người không phải quản trị nền tảng gửi cờ: 403 forbidden, không xếp việc; không gửi cờ thì 202', async () => {
    const { ceo } = await createCompany({ optionalModules: ['channel'] });
    await testPool().query("delete from pgboss.job where name = 'channel.category_sync' and data->>'platform' = 'shopee'");
    const res = await post(ceo.token, { allowShrink: true });
    expect(res.status).toBe(403);
    expect(res.body.type).toBe('/problems/forbidden');
    expect(await queued()).toEqual([]);
    expect((await post(ceo.token, { allowShrink: false })).status).toBe(202);
    expect((await post(ceo.token)).status).toBe(202);
    expect((await queued()).map((r) => r.data.allowShrink ?? false)).toEqual([false]);
  });

  it('quản trị nền tảng gửi cờ: 202, việc mang allowShrink; cờ sai kiểu 422', async () => {
    const { ceo } = await createCompany({ optionalModules: ['channel'] });
    await testPool().query('update core.accounts set is_platform_admin = true where email = $1', [ceo.email]);
    await testPool().query("delete from pgboss.job where name = 'channel.category_sync' and data->>'platform' = 'shopee'");
    expect((await post(ceo.token, { allowShrink: 'yes' })).status).toBe(422);
    const res = await post(ceo.token, { allowShrink: true });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect((await queued()).map((r) => r.data.allowShrink)).toEqual([true]);
    await testPool().query("delete from pgboss.job where name = 'channel.category_sync' and data->>'platform' = 'shopee'");
  });
});

describe('runCategorySync: cây thiếu', () => {
  it('không cờ: chặn, log error kèm số node bỏ và tổng, không ghi; có cờ: ghi, node vắng thành removed', async () => {
    tree = nodes(120);
    await runCategorySync({ platform: 'shopee' });
    tree = nodes(100);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    await expect(runCategorySync({ platform: 'shopee' })).rejects.toBeInstanceOf(CategoryTreeShrunkError);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ platform: 'shopee', removing: 20, active: expect.any(Number) }), expect.any(String));
    expect((await findCategory('shopee', id(110)))?.status).toBe('active');
    await runCategorySync({ platform: 'shopee', allowShrink: true });
    expect((await findCategory('shopee', id(110)))?.status).toBe('removed');
    expect((await findCategory('shopee', id(5)))?.status).toBe('active');
  });
});
