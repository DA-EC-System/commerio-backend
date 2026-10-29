import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { asCompany } from '../../helpers/rls.ts';

const db = testPool();
let creator: string;

beforeAll(async () => {
  const res = await db.query<{ id: string }>(
    "insert into core.accounts (email, full_name) values ($1, 'Người Tạo Link') returning id",
    [uniqueEmail('moi')],
  );
  creator = res.rows[0]!.id;
});

type Columns = Record<string, unknown>;

/** Bảng ca `it.each` dựng trước `beforeAll`: chỗ cần id tài khoản thật ghi `CREATOR`, lúc chèn mới thay. */
const CREATOR = '@creator';

/** Chèn thẳng một lời mời bằng role chủ bảng; `columns` ghi đè cột mặc định. */
async function insertInvitation(columns: Columns = {}): Promise<{ id: string; companyId: string }> {
  const row: Columns = {
    company_id: randomUUID(),
    role_ids: [randomUUID()],
    created_by: CREATOR,
    expires_at: new Date(Date.now() + 72 * 3600_000),
    ...columns,
  };
  const names = Object.keys(row);
  const values = Object.values(row).map((v) => (v === CREATOR ? creator : v));
  const res = await db.query<{ id: string; company_id: string }>(
    `insert into core.invitations (${names.join(', ')}) values (${names.map((_, i) => `$${i + 1}`).join(', ')})
     returning id, company_id`,
    values,
  );
  return { id: res.rows[0]!.id, companyId: res.rows[0]!.company_id };
}

const identity = () => ({
  email: uniqueEmail('nguoi-moi'),
  full_name: 'Người Được Mời',
});
const pending = (extra: Columns = {}) => ({
  status: 'pending',
  ...identity(),
  submitted_at: new Date(),
  password_hash: 'argon2-gia',
  ...extra,
});
const decided = (status: 'approved' | 'rejected', extra: Columns = {}) => ({
  status,
  ...identity(),
  submitted_at: new Date(),
  account_id: CREATOR,
  decided_by: CREATOR,
  decided_at: new Date(),
  ...extra,
});

// Bảng core.invitations (#7 [C], spec 6.3): ràng buộc, RLS, chỉ một yêu cầu chờ duyệt mỗi email mỗi công ty.
describe('core.invitations: ràng buộc', () => {
  it('lời mời mới ở open, đếm OTP bằng 0, version 1', async () => {
    const { id } = await insertInvitation();
    const res = await db.query(
      'select status, otp_attempts, otp_send_count, version from core.invitations where id = $1',
      [id],
    );
    expect(res.rows[0]).toEqual({
      status: 'open',
      otp_attempts: 0,
      otp_send_count: 0,
      version: 1,
    });
  });

  it.each([
    ['invitations_role_ids_nonempty', { role_ids: [] }],
    ['invitations_identity_present', { status: 'claimed', email: null, full_name: 'Người Được Mời' }],
    ['invitations_identity_present', { status: 'claimed', email: uniqueEmail(), full_name: null }],
    ['invitations_pending_shape', pending({ submitted_at: null })],
    ['invitations_pending_shape', pending({ password_hash: null })],
    ['invitations_pending_shape', pending({ account_id: CREATOR })],
    ['invitations_approved_shape', decided('approved', { account_id: null })],
    ['invitations_approved_shape', decided('approved', { decided_by: null })],
    ['invitations_approved_shape', decided('approved', { decided_at: null })],
    ['invitations_rejected_shape', decided('rejected', { decided_by: null })],
    ['invitations_rejected_shape', decided('rejected', { decided_at: null })],
    ['invitations_decided_clean', decided('approved', { password_hash: 'argon2-gia' })],
    ['invitations_decided_clean', decided('rejected', { otp_hash: 'ban-bam' })],
    ['invitations_otp_counters_range', { otp_attempts: 6 }],
    ['invitations_otp_counters_range', { otp_send_count: -1 }],
  ])('chặn bằng %s', async (constraint, columns) => {
    await expect(insertInvitation(columns)).rejects.toMatchObject({
      code: '23514',
      constraint,
    });
  });

  it('pending của tài khoản đã có: account_id, không password_hash', async () => {
    await expect(insertInvitation(pending({ password_hash: null, account_id: creator }))).resolves.toBeDefined();
  });

  it('UPDATE vượt 5 lần sai OTP bị chặn', async () => {
    const { id } = await insertInvitation({ otp_attempts: 5 });
    await expect(
      db.query('update core.invitations set otp_attempts = otp_attempts + 1 where id = $1', [id]),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'invitations_otp_counters_range',
    });
  });

  it('created_by, account_id, decided_by phải là tài khoản có thật', async () => {
    await expect(insertInvitation({ created_by: randomUUID() })).rejects.toMatchObject({ code: '23503' });
    await expect(insertInvitation(decided('rejected', { decided_by: randomUUID() }))).rejects.toMatchObject({
      code: '23503',
    });
  });

  it('một email chỉ có một yêu cầu chờ duyệt trong một công ty', async () => {
    const companyId = randomUUID();
    const email = uniqueEmail('trung');
    await insertInvitation({ company_id: companyId, ...pending({ email }) });
    await expect(insertInvitation({ company_id: companyId, ...pending({ email }) })).rejects.toMatchObject({
      code: '23505',
      constraint: 'invitations_one_pending_per_email',
    });
    // Công ty khác, hay yêu cầu cũ đã từ chối, không chặn.
    await expect(insertInvitation(pending({ email }))).resolves.toBeDefined();
    await expect(
      insertInvitation({
        company_id: companyId,
        ...decided('rejected', { email }),
      }),
    ).resolves.toBeDefined();
  });
});

describe('core.invitations: RLS', () => {
  it('công ty khác không đọc, không sửa được lời mời', async () => {
    const { id } = await insertInvitation();
    const other = randomUUID();
    await asCompany(other, async (c) => {
      expect((await c.query('select 1 from core.invitations where id = $1', [id])).rowCount).toBe(0);
      expect((await c.query("update core.invitations set status = 'claimed' where id = $1", [id])).rowCount).toBe(0);
    });
    expect((await db.query('select status from core.invitations where id = $1', [id])).rows[0]).toEqual({
      status: 'open',
    });
  });

  it('công ty của lời mời đọc và sửa được', async () => {
    const { id, companyId } = await insertInvitation();
    await asCompany(companyId, async (c) => {
      expect((await c.query('select 1 from core.invitations where id = $1', [id])).rowCount).toBe(1);
      expect((await c.query('update core.invitations set version = version + 1 where id = $1', [id])).rowCount).toBe(
        1,
      );
    });
  });

  it('không chèn được lời mời cho công ty khác, không chuyển lời mời sang công ty khác', async () => {
    const { id, companyId } = await insertInvitation();
    await expect(
      asCompany(companyId, (c) =>
        c.query(
          `insert into core.invitations (company_id, role_ids, created_by, expires_at)
           values ($1, $2, $3, now() + interval '72 hours')`,
          [randomUUID(), [randomUUID()], creator],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asCompany(companyId, (c) =>
        c.query('update core.invitations set company_id = $2 where id = $1', [id, randomUUID()]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('commerio_app không xoá được lời mời', async () => {
    const { id, companyId } = await insertInvitation();
    await expect(
      asCompany(companyId, (c) => c.query('delete from core.invitations where id = $1', [id])),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
