// `queuedRunOrInsert` (Documents/21 §18 "Kết quả lượt đồng bộ"): chèn vướng unique lượt `queued`, rồi việc đồng bộ nhận lượt
// đó sang `running` trước câu đọc lại. Trước đây câu đọc rỗng làm POST trả 500; giờ chèn lại và trả lượt mới.
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type * as DbClient from '#src/shared/db/client.ts';
import request from 'supertest';
import { stopJobs } from '#src/modules/core/platform/service/jobs/boss.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { activateShop, fakeAdapter } from './helpers.ts';

// Chen một lần "việc đồng bộ nhận lượt" ngay trước câu SELECT đầu tiên sau khi chèn, bằng kết nối riêng đã commit.
const race = vi.hoisted(() => ({ armed: null as null | (() => Promise<void>) }));
vi.mock('#src/shared/db/client.ts', async (importOriginal) => {
  const real = await importOriginal<typeof DbClient>();
  return {
    ...real,
    getDb: () => {
      const db = real.getDb();
      return new Proxy(db, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop !== 'select' || !race.armed || typeof value !== 'function') return typeof value === 'function' ? value.bind(target) : value;
          const claim = race.armed;
          race.armed = null;
          // Builder của drizzle chỉ chạy khi `await`: bọc `then` để chạy việc chen trước câu đọc.
          return (...args: unknown[]) => {
            const builder = value.apply(target, args);
            return new Proxy(builder, {
              get(b, p, r) {
                const v = Reflect.get(b, p, r);
                if (p === 'from' && typeof v === 'function') {
                  return (...a: unknown[]) => {
                    const q = v.apply(b, a);
                    const where = q.where.bind(q);
                    q.where = (...w: unknown[]) => {
                      const final = where(...w);
                      const then = final.then.bind(final);
                      final.then = (ok: (x: unknown) => unknown, err?: (e: unknown) => unknown) => claim().then(() => then(ok, err), err);
                      return final;
                    };
                    return q;
                  };
                }
                return typeof v === 'function' ? v.bind(b) : v;
              },
            });
          };
        },
      });
    },
  };
});

const { withCompany } = await import('#src/shared/db/client.ts');
const { queuedRunOrInsert } = await import('#src/modules/channel/channel/repository/sync-runs.ts');

registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop đua', region: 'VN' };
    },
  }),
);
afterAll(async () => {
  race.armed = null;
  resetAdapters();
  await stopJobs();
});

describe('queuedRunOrInsert khi đua với việc đồng bộ', () => {
  it('lượt queued bị nhận sang running giữa lúc chèn vướng unique và lúc đọc lại: chèn lại, trả lượt queued mới', async () => {
    const company = await createCompany({ optionalModules: [] });
    const res = await request(testApp())
      .post('/api/v1/channel/shops/lazada/token')
      .set('Authorization', `Bearer ${company.ceo.token}`)
      .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const shopId: string = res.body.shop.id;
    await activateShop(shopId);
    const queued = await testPool().query<{ id: string }>(
      `insert into channel.listing_sync_runs (company_id, shop_id, status) values ($1, $2, 'queued') returning id`,
      [company.companyId, shopId],
    );
    const old = queued.rows[0]!.id;
    race.armed = async () => {
      await testPool().query(`update channel.listing_sync_runs set status = 'running', started_at = now() where id = $1`, [old]);
    };
    const accountId = randomUUID();
    const run = await withCompany(company.companyId, () =>
      queuedRunOrInsert(company.companyId, shopId, accountId, { before: new Date(Date.now() - 30 * 60_000), error: { code: 'run_stale', message: 'x' } }),
    );
    expect(race.armed).toBeNull();
    expect(run.id).not.toBe(old);
    expect(run.status).toBe('queued');
  });
});
