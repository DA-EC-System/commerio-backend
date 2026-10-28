import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { listTransitions, recordTransition } from '#src/modules/core/platform/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';

const base = { entityType: 'stock_documents', action: 'submit', source: 'user' as const };

async function countRows(entityId: string): Promise<number> {
  const { rows } = await testPool().query('select count(*)::int as n from core.state_transitions where entity_id = $1', [entityId]);
  return rows[0].n;
}

describe('lịch sử chuyển trạng thái (core.state_transitions)', () => {
  it('AC-7: ghi đúng một dòng mang công ty hiện tại', async () => {
    const { companyId } = await createCompany();
    const entityId = randomUUID();
    const actorId = randomUUID();
    await withCompany(companyId, () =>
      recordTransition({ ...base, entityId, from: 'draft', to: 'pending', actorId, reason: 'đếm xong' }),
    );
    const { rows } = await testPool().query('select * from core.state_transitions where entity_id = $1', [entityId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      company_id: companyId,
      entity_type: 'stock_documents',
      from_state: 'draft',
      to_state: 'pending',
      action: 'submit',
      actor_id: actorId,
      source: 'user',
      reason: 'đếm xong',
    });
  });

  it('AC-7: giao dịch của bên gọi rollback thì không còn dòng', async () => {
    const { companyId } = await createCompany();
    const entityId = randomUUID();
    await expect(
      withCompany(companyId, async () => {
        await recordTransition({ ...base, entityId, from: 'draft', to: 'pending', actorId: null, source: 'system' });
        throw new Error('nghiệp vụ hỏng sau khi ghi lịch sử');
      }),
    ).rejects.toThrow('nghiệp vụ hỏng');
    expect(await countRows(entityId)).toBe(0);
  });

  it('AC-7: gọi ngoài withCompany thì báo lỗi lập trình, không ghi', async () => {
    const entityId = randomUUID();
    await expect(recordTransition({ ...base, entityId, from: null, to: 'draft', actorId: null })).rejects.toThrow(
      'withCompany',
    );
    expect(await countRows(entityId)).toBe(0);
  });

  it('AC-8: liệt kê theo thứ tự ghi, kể cả hai chuyển trong cùng giao dịch; công ty khác thấy rỗng', async () => {
    const a = await createCompany();
    const b = await createCompany();
    const entityId = randomUUID();
    await withCompany(a.companyId, async () => {
      await recordTransition({ ...base, entityId, from: null, to: 'draft', action: 'create', actorId: null, source: 'system' });
      await recordTransition({ ...base, entityId, from: 'draft', to: 'pending', actorId: null, source: 'marketplace' });
    });
    const list = await withCompany(a.companyId, () => listTransitions('stock_documents', entityId));
    expect(list.map((t) => [t.from, t.to])).toEqual([
      [null, 'draft'],
      ['draft', 'pending'],
    ]);
    expect(list[1]).toMatchObject({ actorId: null, source: 'marketplace', reason: null });
    expect(await withCompany(b.companyId, () => listTransitions('stock_documents', entityId))).toEqual([]);
  });
});
