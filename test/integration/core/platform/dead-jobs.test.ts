import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineQueue, JobDataSchema, sendJob, workQueue } from '#src/modules/core/index.ts';
import { jobBoss } from '#src/modules/core/platform/service/jobs/boss.ts';
import { DEAD_QUEUE } from '#src/modules/core/platform/service/jobs/queues.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';

const app = () => request(testApp());
const queue = defineQueue(`test.dead_api_${randomUUID().slice(0, 8)}`, JobDataSchema, { attempts: 1 });

let a: Awaited<ReturnType<typeof createCompany>>;
let b: Awaited<ReturnType<typeof createCompany>>;
const shopId = randomUUID();

/** Việc lỗi thật: handler luôn ném, hàng chỉ một lượt thử nên rơi thẳng vào hàng việc lỗi. */
beforeAll(async () => {
  a = await createCompany();
  b = await createCompany();
  await workQueue(queue, () => Promise.reject(new Error('sàn trả lỗi 500')));
  await sendJob(queue, { companyId: a.companyId, shopId });
  await sendJob(queue, { companyId: b.companyId });
  const boss = await jobBoss();
  await vi.waitFor(
    async () => {
      const dead = await boss.findJobs(DEAD_QUEUE, { limit: 100_000 });
      expect(dead.filter((j) => j.sourceName === queue.name)).toHaveLength(2);
    },
    { timeout: 20_000, interval: 500 },
  );
  await boss.offWork(queue.name);
}, 30_000);
afterAll(async () => (await jobBoss()).offWork(queue.name));

async function deadOf(token: string, query = `?queue=${queue.name}`) {
  return app().get(`/api/v1/platform/jobs/dead${query}`).set('Authorization', `Bearer ${token}`);
}

describe('API việc lỗi (#102 AC-6)', () => {
  it('Admin chỉ thấy việc lỗi của công ty mình, có hàng gốc, gian hàng, số lượt, lỗi cuối', async () => {
    const admin = await addMember(a.companyId, 'admin');
    const res = await deadOf(admin.token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(res.body.items).toEqual([
      {
        id: expect.any(String),
        queue: queue.name,
        shopId,
        attempts: 1,
        lastError: 'sàn trả lỗi 500',
        failedAt: expect.any(String),
      },
    ]);
  });

  it('thiếu platform.job.manage thì 403', async () => {
    const sale = await addMember(a.companyId, 'sale');
    expect((await deadOf(sale.token)).status).toBe(403);
  });

  it('chạy lại việc của công ty khác thì 404, việc vẫn nằm ở hàng lỗi', async () => {
    const [jobOfB] = (await deadOf(b.ceo.token)).body.items;
    const res = await app()
      .post(`/api/v1/platform/jobs/dead/${jobOfB.id}/retry`)
      .set('Authorization', `Bearer ${a.ceo.token}`);
    expect(res.status).toBe(404);
    expect((await deadOf(b.ceo.token)).body.total).toBe(1);
  });

  it('id không phải uuid thì 404', async () => {
    const res = await app().post('/api/v1/platform/jobs/dead/abc/retry').set('Authorization', `Bearer ${a.ceo.token}`);
    expect(res.status).toBe(404);
  });

  it('chạy lại: việc về hàng gốc với lượt thử mới, rời hàng lỗi, có nhật ký thao tác', async () => {
    const [job] = (await deadOf(a.ceo.token)).body.items;
    const res = await app().post(`/api/v1/platform/jobs/dead/${job.id}/retry`).set('Authorization', `Bearer ${a.ceo.token}`);
    expect(res.status).toBe(204);

    expect((await deadOf(a.ceo.token)).body.total).toBe(0);
    const back = await (await jobBoss()).findJobs(queue.name, { data: { companyId: a.companyId }, queued: true });
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ retryCount: 0, data: { companyId: a.companyId, shopId } });

    const audit = await testPool().query(
      "select action, entity_type, entity_id, before from core.audit_logs where company_id = $1 and entity_type = 'pgboss.job'",
      [a.companyId],
    );
    expect(audit.rows).toEqual([
      { action: 'update', entity_type: 'pgboss.job', entity_id: job.id, before: { queue: queue.name, state: 'dead' } },
    ]);

    const again = await app().post(`/api/v1/platform/jobs/dead/${job.id}/retry`).set('Authorization', `Bearer ${a.ceo.token}`);
    expect(again.status).toBe(404);
  });
});
