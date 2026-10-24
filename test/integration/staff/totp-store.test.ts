import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  advanceTotpStep,
  clearTotp,
  consumeRecoveryCode,
  enableTotp,
  findAccountById,
  isPlatformAdmin,
  saveTotpSecret,
} from '#src/modules/staff/repository/accounts.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { uniqueEmail } from '../helpers/company.ts';
import { testPool } from '../helpers/db.ts';

const db = testPool();
const SECRET = Buffer.from('ban-ma-gia-cua-secret');

async function newAccount(platformAdmin = false): Promise<string> {
  const res = await db.query<{ id: string }>(
    "insert into staff.accounts (email, full_name, is_platform_admin) values ($1, 'Người Thử', $2) returning id",
    [uniqueEmail('totp'), platformAdmin],
  );
  return res.rows[0]!.id;
}

async function enabledAccount(step = 100, hashes = ['bam-a', 'bam-b']): Promise<string> {
  const id = await newAccount();
  expect(await saveTotpSecret(id, SECRET)).toBe(true);
  expect(await enableTotp(id, step, hashes)).toBe(true);
  return id;
}

const columns = async (id: string) =>
  (
    await db.query(
      'select totp_secret_enc, totp_enabled_at, totp_last_step, recovery_code_hashes from staff.accounts where id = $1',
      [id],
    )
  ).rows[0] as Record<string, unknown>;

// Cột TOTP của staff.accounts và câu ghi có điều kiện (#7 [D], spec 6.3, 6.7 "Login 2FA", "Setup, confirm").
describe('lưu TOTP của tài khoản', () => {
  it('thiết lập: ghi secret khi chưa bật (gọi lại thì ghi đè), bật một lần; bật rồi không ghi đè secret được', async () => {
    const id = await newAccount();
    expect(await enableTotp(id, 1, [])).toBe(false);
    expect(await saveTotpSecret(id, Buffer.from('cu'))).toBe(true);
    expect(await saveTotpSecret(id, SECRET)).toBe(true);
    expect(await enableTotp(id, 100, ['bam-a', 'bam-b'])).toBe(true);
    expect(await enableTotp(id, 101, [])).toBe(false);
    expect(await saveTotpSecret(id, Buffer.from('moi'))).toBe(false);
    expect(await columns(id)).toMatchObject({
      totp_secret_enc: SECRET,
      totp_last_step: '100',
      recovery_code_hashes: ['bam-a', 'bam-b'],
    });
    const account = await findAccountById(id);
    expect(account).toMatchObject({ totpSecretEnc: SECRET, totpEnabledAt: expect.any(Date) });
  });

  it('advanceTotpStep không lùi và không dùng lại cùng bước', async () => {
    const id = await enabledAccount(100);
    expect(await advanceTotpStep(id, 100)).toBe(false);
    expect(await advanceTotpStep(id, 99)).toBe(false);
    expect(await advanceTotpStep(id, 101)).toBe(true);
    expect(await advanceTotpStep(id, 101)).toBe(false);
    expect(await advanceTotpStep(await newAccount(), 500)).toBe(false);
  });

  it('hai lần dùng cùng bước song song: đúng một true', async () => {
    const id = await enabledAccount(100);
    const results = await Promise.all([advanceTotpStep(id, 102), advanceTotpStep(id, 102)]);
    expect(results.sort()).toEqual([false, true]);
  });

  it('hai lần dùng cùng mã khôi phục song song: đúng một true; mã còn lại vẫn dùng được', async () => {
    const id = await enabledAccount();
    const results = await Promise.all([consumeRecoveryCode(id, 'bam-a'), consumeRecoveryCode(id, 'bam-a')]);
    expect(results.sort()).toEqual([false, true]);
    expect((await columns(id)).recovery_code_hashes).toEqual(['bam-b']);
    expect(await consumeRecoveryCode(id, 'bam-b')).toBe(true);
    expect(await consumeRecoveryCode(id, 'bam-b')).toBe(false);
  });

  it('clearTotp xoá secret, cờ bật, bước, mã khôi phục; tài khoản không tồn tại thì false', async () => {
    const id = await enabledAccount();
    expect(await clearTotp(id)).toBe(true);
    expect(await columns(id)).toEqual({
      totp_secret_enc: null,
      totp_enabled_at: null,
      totp_last_step: null,
      recovery_code_hashes: [],
    });
    expect(await clearTotp(randomUUID())).toBe(false);
  });

  it('đã bật thì phải có secret (CHECK accounts_totp_enabled_has_secret)', async () => {
    const id = await newAccount();
    await expect(
      db.query('update staff.accounts set totp_enabled_at = now() where id = $1', [id]),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'accounts_totp_enabled_has_secret',
    });
  });

  it('gọi trong withCompany thì ném lỗi lập trình (commerio_app không UPDATE staff.accounts)', async () => {
    const id = await newAccount();
    for (const call of [
      () => saveTotpSecret(id, SECRET),
      () => enableTotp(id, 1, []),
      () => advanceTotpStep(id, 1),
      () => consumeRecoveryCode(id, 'x'),
      () => clearTotp(id),
    ]) {
      await expect(withCompany(randomUUID(), call)).rejects.toThrow(/ngoài withCompany/);
    }
  });

  it('isPlatformAdmin đọc cờ trong DB', async () => {
    expect(await isPlatformAdmin(await newAccount(true))).toBe(true);
    expect(await isPlatformAdmin(await newAccount())).toBe(false);
    expect(await isPlatformAdmin(randomUUID())).toBe(false);
  });
});

describe('cột TOTP của lời mời', () => {
  const invitation = async (columns: string, values: unknown[]) => {
    const creator = await newAccount();
    return db.query(
      `insert into staff.invitations (company_id, role_ids, created_by, expires_at, status, email, full_name,
         submitted_at, decided_by, decided_at, account_id, ${columns})
       values ($1, $2, $3, now() + interval '72 hours', 'rejected', $4, 'Người Thử', now(), $3, now(), $3, $5, $6)`,
      [randomUUID(), [randomUUID()], creator, uniqueEmail(), ...values],
    );
  };

  it('đã xác nhận thì phải có secret; đã quyết định thì không còn secret, mã khôi phục', async () => {
    await expect(invitation('totp_confirmed_at, totp_secret_enc', [new Date(), null])).rejects.toMatchObject({
      constraint: 'invitations_totp_confirmed_has_secret',
    });
    await expect(invitation('totp_confirmed_at, totp_secret_enc', [null, SECRET])).rejects.toMatchObject({
      constraint: 'invitations_decided_clean',
    });
    await expect(invitation('recovery_code_hashes, totp_secret_enc', [['bam-a'], null])).rejects.toMatchObject({
      constraint: 'invitations_decided_clean',
    });
  });
});
