import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { jobBoss, stopJobs } from '#src/modules/core/platform/service/jobs/boss.ts';
import { createCompany } from '../../helpers/company.ts';
import { asCompany } from '../../helpers/rls.ts';

afterAll(stopJobs);

describe('hàng việc nền pg-boss (#102)', () => {
  it('AC-S3: khởi động trên schema của migration 0007, không tự migrate', async () => {
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
});
