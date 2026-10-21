import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

// Tài khoản demo có 2FA bật sẵn từ secret cố định (#7 [D], B15), chạy với 2FA bắt buộc.
vi.hoisted(() => {
  process.env.TWO_FACTOR_MODE = 'required';
});

const { seedDemo } = await import('../../../db/seed/demo.ts');
const { base32Decode, TOTP_STEP_SECONDS, totpAt } = await import('#src/shared/crypto/totp.ts');
const { uniqueEmail } = await import('../helpers/company.ts');
const { testPool } = await import('../helpers/db.ts');
const { PASSWORD, testApp } = await import('../helpers/http.ts');

const db = testPool();
const app = testApp();
// Dữ liệu giả, công khai như DEMO_TOTP_SECRET trong .env.example.
const DEMO_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

function demoInput() {
  return {
    company: { name: 'Công ty Demo 2FA', taxCode: '0300000038' },
    password: PASSWORD,
    totpSecret: DEMO_SECRET,
    accounts: {
      ceo: { email: uniqueEmail('ceo'), fullName: 'CEO Demo' },
      admin: { email: uniqueEmail('admin'), fullName: 'Admin Demo' },
      sale: { email: uniqueEmail('sale'), fullName: 'Sale Demo' },
      kho: { email: uniqueEmail('kho'), fullName: 'Kho Demo' },
    },
  };
}

const totpColumns = async (emails: string[]) =>
  (
    await db.query<{ email: string; totp_secret_enc: Buffer | null; totp_enabled_at: Date | null }>(
      'select email, totp_secret_enc, totp_enabled_at from staff.accounts where email = any($1) order by email',
      [emails],
    )
  ).rows;

describe('seed demo có 2FA', () => {
  it('bốn tài khoản demo bật 2FA bằng secret cố định; chạy lại không đổi; đăng nhập qua login/2fa bằng mã từ secret đó', async () => {
    const input = demoInput();
    const emails = Object.values(input.accounts).map((a) => a.email);
    await seedDemo(input);
    const first = await totpColumns(emails);
    expect(first).toHaveLength(4);
    for (const row of first) expect(row.totp_enabled_at).not.toBeNull();

    await seedDemo(input);
    expect(await totpColumns(emails)).toEqual(first);

    const login = await request(app)
      .post('/api/v1/identity/login')
      .send({ email: input.accounts.sale.email, password: PASSWORD });
    expect(login.body.mfaRequired).toBe(true);
    const step = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
    const session = await request(app)
      .post('/api/v1/identity/login/2fa')
      .send({ mfaToken: login.body.mfaToken, code: totpAt(base32Decode(DEMO_SECRET), step) });
    expect(session.status).toBe(200);
  });

  it('không có totpSecret thì tài khoản demo chưa bật 2FA (thiết lập ở lần đăng nhập đầu)', async () => {
    const input: ReturnType<typeof demoInput> = { ...demoInput(), totpSecret: '' };
    await seedDemo(input);
    const rows = await totpColumns(Object.values(input.accounts).map((a) => a.email));
    for (const row of rows) expect(row.totp_enabled_at).toBeNull();
  });
});
