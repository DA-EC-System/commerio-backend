import { randomUUID } from 'node:crypto';
import { PgBoss } from 'pg-boss';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { jobBoss, stopJobs } from '#src/modules/core/platform/service/jobs/boss.ts';
import {
  countHeld,
  DEAD_QUEUE,
  defineQueue,
  HoldJob,
  JobDataSchema,
  releaseHeld,
  scheduleForShop,
  sendJob,
  unscheduleForShop,
  workQueue,
} from '#src/modules/core/platform/service/jobs/queues.ts';
import { inTransaction, withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { asCompany } from '../../helpers/rls.ts';

afterAll(stopJobs);

const TestData = JobDataSchema.extend({ marker: z.string() });
const testQueue = (options = {}) => defineQueue(`test.q-${randomUUID()}`, TestData, options);

describe('hàng việc nền pg-boss (#102)', () => {
  it('AC-S3: khởi động trên schema của migration 0011, không tự migrate', async () => {
    const boss = await jobBoss();
    expect(Array.isArray(await boss.getQueues())).toBe(true);
  });

  it('AC-S3: commerio_app gửi được việc (chỉ có quyền DML trên pgboss)', async () => {
    const boss = await jobBoss();
    const queue = `test.dml-${randomUUID()}`;
    await boss.createQueue(queue);
    const { companyId } = await createCompany();
    const id = await asCompany(companyId, (c) =>
      boss.send(queue, { companyId }, { db: { executeSql: (text, values) => c.query(text, values) } }),
    );
    expect(id).toEqual(expect.any(String));
  });

  it('AC-1: hàng mặc định thử 5 lần, giãn cách từ 60 giây gấp đôi tới 1 giờ, hết lượt thì sang hàng việc lỗi', async () => {
    const queue = testQueue();
    const { companyId } = await createCompany();
    await sendJob(queue, { companyId, marker: 'x' });
    expect(await (await jobBoss()).getQueue(queue.name)).toMatchObject({
      policy: 'standard',
      retryLimit: 4,
      retryDelay: 60,
      retryBackoff: true,
      retryDelayMax: 3600,
      deadLetter: DEAD_QUEUE,
    });
  });

  it('AC-1: hàng stately gửi hai lần cùng khoá khi việc trước còn chờ thì chỉ có một việc', async () => {
    const queue = testQueue({ policy: 'stately' });
    const { companyId } = await createCompany();
    const key = randomUUID();
    expect(await sendJob(queue, { companyId, marker: 'a' }, { key })).toEqual(expect.any(String));
    expect(await sendJob(queue, { companyId, marker: 'b' }, { key })).toBeNull();
    expect(await (await jobBoss()).findJobs(queue.name, { key })).toHaveLength(1);
  });

  it('A4: gửi việc trong giao dịch bị rollback thì không còn việc', async () => {
    const queue = testQueue();
    const { companyId } = await createCompany();
    const marker = randomUUID();
    await expect(
      inTransaction(async () => {
        await sendJob(queue, { companyId, marker });
        throw new Error('lỗi giữa chừng');
      }),
    ).rejects.toThrow('lỗi giữa chừng');
    expect(await (await jobBoss()).findJobs(queue.name, { data: { marker } })).toHaveLength(0);
  });

  it('AC-S3: sendJob trong withCompany (role commerio_app) đi chung giao dịch của công ty', async () => {
    const queue = testQueue();
    const { companyId } = await createCompany();
    const marker = randomUUID();
    await withCompany(companyId, () => sendJob(queue, { companyId, marker }));
    expect(await (await jobBoss()).findJobs(queue.name, { data: { marker } })).toHaveLength(1);
  });

  it('việc thiếu companyId bị từ chối trước khi gửi', async () => {
    const queue = testQueue();
    await expect(sendJob(queue, { marker: 'x' } as never)).rejects.toThrow();
  });

  it('AC-1: handler lỗi đến lần thử cuối thì việc nằm ở hàng việc lỗi, giữ dữ liệu và lỗi cuối', async () => {
    const queue = testQueue({ attempts: 1 });
    const { companyId } = await createCompany();
    const marker = randomUUID();
    await workQueue(queue, () => Promise.reject(new Error('sàn trả lỗi')));
    await sendJob(queue, { companyId, marker });
    const boss = await jobBoss();
    const dead = await vi.waitFor(
      async () => {
        const jobs = await boss.findJobs(DEAD_QUEUE, { data: { marker } });
        expect(jobs).toHaveLength(1);
        return jobs[0]!;
      },
      { timeout: 20_000, interval: 500 },
    );
    expect(dead.data).toMatchObject({ companyId, marker });
    expect(JSON.stringify(dead.sourceOutput)).toContain('sàn trả lỗi');
    await boss.offWork(queue.name);
  }, 30_000);

  it('AC-2: hai worker cùng nhận một hàng thì mỗi việc chạy đúng một lần', async () => {
    const queue = testQueue();
    const { companyId } = await createCompany();
    const seen: string[] = [];
    await workQueue(queue, async (d) => void seen.push(d.marker));
    const other = new PgBoss({ connectionString: process.env.DATABASE_URL, schema: 'pgboss', migrate: false, supervise: false, schedule: false, registerInstance: false });
    other.on('error', () => undefined);
    await other.start();
    try {
      await other.work<{ marker: string }>(queue.name, async ([job]) => void seen.push(job!.data.marker));
      const markers = Array.from({ length: 6 }, (_, i) => `m${i}`);
      for (const marker of markers) await sendJob(queue, { companyId, marker });
      await vi.waitFor(() => expect(seen).toHaveLength(6), { timeout: 20_000, interval: 500 });
      expect(new Set(seen).size).toBe(6);
    } finally {
      await other.stop({ graceful: false, close: true });
      await (await jobBoss()).offWork(queue.name);
    }
  }, 30_000);
});

describe('giữ việc khi gian hàng mất token, lịch theo gian hàng (#102 A3, A5)', () => {
  it('AC-4: handler ném HoldJob thì việc được giữ (không tốn lượt thử); trả lại thì chạy tiếp ở hàng gốc', async () => {
    const queue = testQueue({ attempts: 1 });
    const { companyId } = await createCompany();
    const shopId = randomUUID();
    const runs: string[] = [];
    let authorized = false;
    await workQueue(queue, async (d) => {
      runs.push(d.marker);
      if (!authorized) throw new HoldJob('mất token');
    });
    await sendJob(queue, { companyId, shopId, marker: 'giữ' });
    await vi.waitFor(async () => expect((await countHeld([shopId])).get(shopId)).toBe(1), { timeout: 20_000, interval: 500 });
    const boss = await jobBoss();
    expect(await boss.findJobs(DEAD_QUEUE, { data: { shopId } })).toHaveLength(0);

    authorized = true;
    expect(await releaseHeld(shopId)).toBe(1);
    expect((await countHeld([shopId])).get(shopId) ?? 0).toBe(0);
    await vi.waitFor(() => expect(runs).toEqual(['giữ', 'giữ']), { timeout: 20_000, interval: 500 });
    await boss.offWork(queue.name);
  }, 45_000);

  it('A3: lịch theo gian hàng có khoá là shopId; bỏ lịch thì hết', async () => {
    const queue = testQueue({ policy: 'stately' });
    const { companyId } = await createCompany();
    const shopId = randomUUID();
    await scheduleForShop(queue, '*/15 * * * *', { companyId, shopId, marker: 'lịch' });
    const boss = await jobBoss();
    expect(await boss.getSchedules(queue.name, shopId)).toEqual([
      expect.objectContaining({ name: queue.name, key: shopId, cron: '*/15 * * * *', data: { companyId, shopId, marker: 'lịch' } }),
    ]);
    await unscheduleForShop(queue, shopId);
    expect(await boss.getSchedules(queue.name, shopId)).toEqual([]);
  });
});
