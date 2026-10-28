import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { recordTransition } from '#src/modules/core/platform/index.ts';
import { canSelfApprove, getStatusHistory } from '#src/modules/core/staff/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { suspendMembership } from '../../helpers/state.ts';

async function ceoOf(companyId: string): Promise<{ accountId: string; membershipId: string }> {
  const { rows } = await testPool().query(
    `select m.account_id, m.id from core.memberships m
       join core.member_roles r on r.membership_id = m.id
      where m.company_id = $1 and r.role_id = '00000000-0000-4000-8000-000000000001'`,
    [companyId],
  );
  return { accountId: rows[0].account_id, membershipId: rows[0].id };
}

describe('canSelfApprove (AC-10)', () => {
  it('CEO được tự duyệt; nhân viên khác thì không khi công ty còn người khác', async () => {
    const { companyId } = await createCompany();
    const ceo = await ceoOf(companyId);
    const admin = await addMember(companyId, 'admin');
    await withCompany(companyId, async () => {
      expect(await canSelfApprove(ceo.accountId)).toBe(true);
      expect(await canSelfApprove(admin.accountId)).toBe(false);
    });
  });

  it('khách thuê chỉ còn một thành viên đang hoạt động thì người đó được tự duyệt', async () => {
    const { companyId } = await createCompany();
    const ceo = await ceoOf(companyId);
    const admin = await addMember(companyId, 'admin');
    await suspendMembership(ceo.membershipId);
    await withCompany(companyId, async () => expect(await canSelfApprove(admin.accountId)).toBe(true));
  });

  it('tài khoản không thuộc công ty thì không', async () => {
    const { companyId } = await createCompany();
    await withCompany(companyId, async () => expect(await canSelfApprove(randomUUID())).toBe(false));
  });
});

describe('getStatusHistory (AC-8)', () => {
  it('trả StatusChange theo Documents/21 mục 14.1: by có tên khi người làm, null khi hệ thống', async () => {
    const { companyId } = await createCompany();
    const ceo = await ceoOf(companyId);
    const entityId = randomUUID();
    await withCompany(companyId, async () => {
      await recordTransition({ entityType: 'packages', entityId, from: null, to: 'reserved', action: 'create', actorId: null });
      await recordTransition({
        entityType: 'packages',
        entityId,
        from: 'reserved',
        to: 'packed',
        action: 'pack',
        actorId: ceo.accountId,
        reason: 'đủ món',
      });
    });
    const { rows } = await testPool().query('select full_name from core.accounts where id = $1', [ceo.accountId]);
    const history = await withCompany(companyId, () => getStatusHistory('packages', entityId));
    expect(history).toEqual([
      { at: expect.any(Date), from: null, to: 'reserved', by: null, source: 'system', reason: null },
      {
        at: expect.any(Date),
        from: 'reserved',
        to: 'packed',
        by: { id: ceo.accountId, name: rows[0].full_name },
        source: 'user',
        reason: 'đủ món',
      },
    ]);
  });
});
