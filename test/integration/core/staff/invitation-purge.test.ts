import { describe, expect, it } from 'vitest';
import { BUILTIN_ROLES } from '#src/modules/core/access/domain/catalog.ts';
import { runInvitationPurge } from '#src/modules/core/staff/service/invitation-purge.ts';
import { createCompany, uniqueEmail } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { accountIdOf, pendingInvitation } from './helpers.ts';

const db = testPool();

type Row = {
  status: string;
  email: string | null;
  full_name: string | null;
  otp_hash: string | null;
  purged_at: Date | null;
};

async function draft(
  companyId: string,
  createdBy: string,
  status: 'open' | 'claimed',
  expiresIn: string,
): Promise<{ id: string; email: string }> {
  const email = uniqueEmail('nhap');
  const res = await db.query<{ id: string }>(
    `insert into core.invitations
       (company_id, role_ids, created_by, expires_at, status, email, full_name, otp_hash, otp_expires_at, otp_send_count)
     values ($1, $2, $3, now() + $4::interval, $5, $6, 'Người Nháp', 'abc', now(), 1)
     returning id`,
    [companyId, [BUILTIN_ROLES.sale.id], createdBy, expiresIn, status, email],
  );
  return { id: res.rows[0]!.id, email };
}

const read = async (id: string) =>
  (
    await db.query<Row>(
      'select status, email, full_name, otp_hash, purged_at from core.invitations where id = $1',
      [id],
    )
  ).rows[0]!;

// Hotfix 19/11/2026: nháp lời mời quá hạn chưa nộp mật khẩu bị xoá email, họ tên, mã OTP; giữ dòng.
describe('dọn nháp lời mời quá hạn', () => {
  it('xoá email, họ tên, mã OTP của link open/claimed đã hết hạn; không đụng link còn hạn hay đã nộp', async () => {
    const { companyId, ceo: c } = await createCompany();
    const ceo = { accountId: await accountIdOf(c.email) };
    const openExpired = await draft(companyId, ceo.accountId, 'open', '-1 minute');
    const claimedExpired = await draft(companyId, ceo.accountId, 'claimed', '-2 hours');
    const claimedLive = await draft(companyId, ceo.accountId, 'claimed', '1 hour');
    const pending = await pendingInvitation(companyId, { createdBy: ceo.accountId, roleIds: [BUILTIN_ROLES.sale.id] });
    await db.query("update core.invitations set expires_at = now() - interval '1 day' where id = $1", [pending.id]);

    expect(await runInvitationPurge()).toBeGreaterThanOrEqual(2);

    for (const { id } of [openExpired, claimedExpired]) {
      expect(await read(id)).toMatchObject({ email: null, full_name: null, otp_hash: null, purged_at: expect.any(Date) });
    }
    expect((await read(claimedExpired.id)).status).toBe('claimed');
    expect(await read(claimedLive.id)).toMatchObject({ email: claimedLive.email, purged_at: null });
    expect(await read(pending.id)).toMatchObject({ status: 'pending', email: pending.email, purged_at: null });

    // Chạy lại không dọn thêm dòng nào của công ty này.
    await runInvitationPurge();
    expect((await read(claimedLive.id)).email).toBe(claimedLive.email);
  });

  it('CHECK: dòng đã dọn không được giữ email', async () => {
    const { companyId, ceo: c } = await createCompany();
    const ceo = { accountId: await accountIdOf(c.email) };
    const { id } = await draft(companyId, ceo.accountId, 'claimed', '-1 minute');
    await expect(
      db.query('update core.invitations set purged_at = now() where id = $1', [id]),
    ).rejects.toMatchObject({ constraint: 'invitations_purged_shape' });
  });
});
