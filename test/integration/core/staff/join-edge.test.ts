import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BUILTIN_ROLES } from '#src/modules/core/access/domain/catalog.ts';
import { otpHash } from '#src/modules/core/staff/domain/otp.ts';
import { signPurposeToken } from '#src/shared/auth/purpose-token.ts';
import { setMailTransport } from '#src/shared/mail/index.ts';
import { addMember, createCompany, uniqueEmail } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { PASSWORD, testApp } from '../../helpers/http.ts';
import { captureMail, codeIn, deliverOtp, joinApi, newLink, otpEvents } from './helpers.ts';

const app = testApp();
const db = testPool();
const join = joinApi(app);
const NEW_PASSWORD = 'MatKhauMoi9';

let company: Awaited<ReturnType<typeof createCompany>>;

beforeAll(async () => {
  company = await createCompany();
});

afterEach(() => {
  setMailTransport(null);
  vi.useRealTimers();
});

const link = () => newLink(app, company.ceo.token, [BUILTIN_ROLES.sale.id]);
const row = async (id: string) =>
  (await db.query('select * from core.invitations where id = $1', [id])).rows[0] as Record<string, unknown>;
/** Bỏ thời gian chờ 60 giây trước lần xin mã kế tiếp. */
const skipCooldown = (id: string) =>
  db.query("update core.invitations set otp_requested_at = otp_requested_at - interval '61 seconds' where id = $1", [
    id,
  ]);
const errorKeys = (res: { body: { errors?: object } }) => Object.keys(res.body.errors ?? {});

/** Xin mã cho email, làm thay worker gửi thư, trả mã trong thư mới nhất. */
async function requestCode(l: { id: string; token: string }, email: string, sent: ReturnType<typeof captureMail>) {
  expect((await join.otp(l.token, email)).status).toBe(202);
  await deliverOtp(l.id);
  return codeIn(sent.at(-1)!);
}

/** Link đã qua OTP (`claimed`) với email này. */
async function claimed(email: string) {
  const sent = captureMail();
  const l = await link();
  const res = await join.verify(l.token, email, await requestCode(l, email, sent));
  expect(res.status).toBe(200);
  return { ...l, email, registrationToken: res.body.registrationToken as string, next: res.body.next as string };
}

// Ca biên của luồng tham gia (#7 [C], spec 6.5, 6.7; AC-C3..C11, C19, C20, Review Focus 1, 2).
describe('tham gia qua link: ca biên', () => {
  it('AC-C3: link hết hạn hay không còn lời mời → 410 invitation_invalid ở check, otp, verify; không phát sự kiện', async () => {
    const expired = await link();
    await db.query("update core.invitations set expires_at = now() - interval '1 hour' where id = $1", [expired.id]);
    const ghost = await signPurposeToken('invite', { jti: randomUUID(), cid: company.companyId });
    for (const token of [expired.token, ghost]) {
      for (const res of [
        await join.check(token),
        await join.otp(token, uniqueEmail()),
        await join.verify(token, uniqueEmail(), '123456'),
      ]) {
        expect(res.status).toBe(410);
        expect(res.body.code).toBe('invitation_invalid');
      }
    }
    expect(await otpEvents(expired.id)).toBe(0);
  });

  it('AC-C4: xin mã → 202 như nhau dù email có tài khoản hay không; đúng một thư có mã 6 số; DB chỉ giữ bản băm', async () => {
    const sent = captureMail();
    const known = await addMember((await createCompany()).companyId, 'sale');
    const [a, b] = [await link(), await link()];
    const fresh = await join.otp(a.token, uniqueEmail());
    const existing = await join.otp(b.token, known.email);
    expect([fresh.status, existing.status]).toEqual([202, 202]);
    expect(existing.body).toEqual(fresh.body);
    await deliverOtp(b.id);
    expect(sent).toHaveLength(1);
    const code = codeIn(sent[0]!);
    const stored = await row(b.id);
    expect(stored.otp_hash).toBe(otpHash(code, b.id));
    expect(Object.values(stored)).not.toContain(code);
  });

  it('AC-C5: xin lại trong 60 giây, quá 5 lần gửi → 429 kèm Retry-After, không phát sự kiện', async () => {
    captureMail();
    const l = await link();
    const email = uniqueEmail();
    expect((await join.otp(l.token, email)).status).toBe(202);
    const again = await join.otp(l.token, email);
    expect(again.status).toBe(429);
    expect(again.body.code).toBe('too_many_requests');
    expect(Number(again.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(again.headers['retry-after'])).toBeLessThanOrEqual(60);
    await db.query(
      "update core.invitations set otp_send_count = 5, otp_requested_at = now() - interval '2 minutes' where id = $1",
      [l.id],
    );
    expect((await join.otp(l.token, email)).status).toBe(429);
    expect(await otpEvents(l.id)).toBe(1);
  });

  it('AC-C6: mã sai → 422 errors.code; sai đủ 5 lần thì mã đúng cũng hết hiệu lực', async () => {
    const sent = captureMail();
    const l = await link();
    const email = uniqueEmail();
    const code = await requestCode(l, email, sent);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const res = await join.verify(l.token, email, wrong);
      expect(res.status).toBe(422);
      expect(errorKeys(res)).toEqual(['code']);
    }
    expect((await join.verify(l.token, email, code)).status).toBe(422);
    expect((await row(l.id)).otp_attempts).toBe(5);
  });

  it('AC-C6: mã quá 5 phút → 422 errors.code', async () => {
    const sent = captureMail();
    const l = await link();
    const email = uniqueEmail();
    const code = await requestCode(l, email, sent);
    await db.query("update core.invitations set otp_expires_at = now() - interval '1 hour' where id = $1", [l.id]);
    const res = await join.verify(l.token, email, code);
    expect(res.status).toBe(422);
    expect(errorKeys(res)).toEqual(['code']);
  });

  it('AC-C6: xin mã cho email khác lúc còn open thì mã cũ mất hiệu lực', async () => {
    const sent = captureMail();
    const l = await link();
    const [first, second] = [uniqueEmail(), uniqueEmail()];
    const oldCode = await requestCode(l, first, sent);
    await skipCooldown(l.id);
    expect((await join.otp(l.token, second)).status).toBe(202);
    expect((await join.verify(l.token, first, oldCode)).status).toBe(422);
    expect((await join.verify(l.token, second, oldCode)).status).toBe(422);
    await deliverOtp(l.id);
    expect((await join.verify(l.token, second, codeIn(sent.at(-1)!))).status).toBe(200);
  });

  it('AC-C7: mã đúng, email mới → set_password, lời mời claimed với email đó; email khác dùng lại link → 409 invitation_used', async () => {
    const email = uniqueEmail();
    const c = await claimed(email);
    expect(c.next).toBe('set_password');
    expect(await row(c.id)).toMatchObject({ status: 'claimed', email, otp_hash: null });
    const other = uniqueEmail();
    expect((await join.otp(c.token, other)).body.code).toBe('invitation_used');
    expect((await join.verify(c.token, other, '123456')).body.code).toBe('invitation_used');
    // Người đang làm dở vẫn mở lại được link.
    expect((await join.check(c.token)).status).toBe(200);
  });

  it('AC-C8: set_password thiếu confirmPassword → 422 errors.confirmPassword; đủ thì pending, đã nộp rồi thì 409', async () => {
    const c = await claimed(uniqueEmail());
    const missing = await join.complete({ registrationToken: c.registrationToken, password: NEW_PASSWORD });
    expect(missing.status).toBe(422);
    expect(errorKeys(missing)).toEqual(['confirmPassword']);
    const body = { registrationToken: c.registrationToken, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD };
    expect((await join.complete(body)).body).toEqual({ status: 'pending' });
    expect((await join.complete(body)).body.code).toBe('invitation_used');
    expect((await join.check(c.token)).body.code).toBe('invitation_used');
  });

  it('AC-C9: email đã có tài khoản ở công ty khác → sign_in; sai mật khẩu → 422 errors.password; đúng → pending, không đổi mật khẩu; không lộ công ty kia', async () => {
    const other = await createCompany();
    const known = await addMember(other.companyId, 'sale');
    const before = await db.query('select password_hash, version from core.accounts where id = $1', [known.accountId]);
    const c = await claimed(known.email);
    expect(c.next).toBe('sign_in');
    const wrong = await join.complete({ registrationToken: c.registrationToken, password: 'SaiMatKhau1' });
    expect(wrong.status).toBe(422);
    expect(errorKeys(wrong)).toEqual(['password']);
    const ok = await join.complete({ registrationToken: c.registrationToken, password: PASSWORD });
    expect(ok.body).toEqual({ status: 'pending' });
    expect(await row(c.id)).toMatchObject({ status: 'pending', account_id: known.accountId, password_hash: null });
    const after = await db.query('select password_hash, version from core.accounts where id = $1', [known.accountId]);
    expect(after.rows).toEqual(before.rows);
    const name = (await db.query('select name from core.companies where id = $1', [other.companyId])).rows[0].name;
    for (const res of [wrong, ok, await join.check(c.token)]) {
      expect(JSON.stringify(res.body)).not.toContain(other.companyId);
      expect(JSON.stringify(res.body)).not.toContain(name);
    }
  });

  it('AC-C10: email đã là thành viên → 409 already_member ở verify; email quản trị nền tảng → 422 errors.email', async () => {
    const sent = captureMail();
    const member = await addMember(company.companyId, 'sale');
    const l = await link();
    const already = await join.verify(l.token, member.email, await requestCode(l, member.email, sent));
    expect(already.status).toBe(409);
    expect(already.body.code).toBe('already_member');
    expect(already.body.member).toBeUndefined();

    const adminEmail = uniqueEmail('quan-tri');
    await db.query("insert into core.accounts (email, full_name, is_platform_admin) values ($1, 'Quản Trị', true)", [
      adminEmail,
    ]);
    const l2 = await link();
    const admin = await join.verify(l2.token, adminEmail, await requestCode(l2, adminEmail, sent));
    expect(admin.status).toBe(422);
    expect(errorKeys(admin)).toEqual(['email']);
  });

  it('AC-C11: registrationToken quá 30 phút → 410 registration_expired', async () => {
    const c = await claimed(uniqueEmail());
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() - 31 * 60_000);
    const old = await signPurposeToken('join', { jti: c.id, cid: company.companyId, em: c.email, nxt: 'set_password' });
    vi.useRealTimers();
    const res = await join.complete({ registrationToken: old, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('registration_expired');
  });

  it('complete khi link đã hết hạn → 410 invitation_invalid', async () => {
    const c = await claimed(uniqueEmail());
    await db.query("update core.invitations set expires_at = now() - interval '1 hour' where id = $1", [c.id]);
    const res = await join.complete({
      registrationToken: c.registrationToken,
      password: NEW_PASSWORD,
      confirmPassword: NEW_PASSWORD,
    });
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('invitation_invalid');
  });

  it('AC-C19: request /join/otp không gửi thư; worker gặp lỗi SMTP tạm thời thì ném để thử lại, mã chưa ghi', async () => {
    captureMail({ code: 'ECONNECTION' });
    const l = await link();
    expect((await join.otp(l.token, uniqueEmail())).status).toBe(202);
    await expect(deliverOtp(l.id)).rejects.toMatchObject({ kind: 'transient' });
    expect((await row(l.id)).otp_hash).toBeNull();
    const sent = captureMail();
    await deliverOtp(l.id);
    expect(sent).toHaveLength(1);
  });

  it('AC-C20: phản hồi, nhật ký không chứa mật khẩu, mã OTP, token link, token đăng ký', async () => {
    const sent = captureMail();
    const l = await link();
    const email = uniqueEmail();
    const responses = [await join.check(l.token), await join.otp(l.token, email)];
    await deliverOtp(l.id);
    const code = codeIn(sent[0]!);
    const verified = await join.verify(l.token, email, code);
    const { registrationToken } = verified.body as { registrationToken: string };
    responses.push(
      await join.complete({ registrationToken, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD }),
      await join.check(l.token),
    );
    const audit = await db.query('select before, after from core.audit_logs where company_id = $1', [
      company.companyId,
    ]);
    const text = JSON.stringify([...responses.map((r) => r.body), verified.body.next, audit.rows]);
    for (const secret of [NEW_PASSWORD, code, l.token, registrationToken]) expect(text).not.toContain(secret);
  });

  it('Review Focus 1: không API nào của /join trả 401', async () => {
    const sent = captureMail();
    const l = await link();
    const email = uniqueEmail();
    const code = await requestCode(l, email, sent);
    const statuses = [
      (await join.check('khong-phai-jwt')).status,
      (await join.otp(l.token, email)).status,
      (await join.verify(l.token, email, code === '000000' ? '111111' : '000000')).status,
      (await join.verify(l.token, uniqueEmail(), code)).status,
      (await join.complete({ registrationToken: 'khong-phai-jwt', password: NEW_PASSWORD })).status,
      (await join.complete({ registrationToken: l.token, password: NEW_PASSWORD })).status,
    ];
    const c = await claimed(uniqueEmail());
    statuses.push((await join.complete({ registrationToken: c.registrationToken, password: NEW_PASSWORD })).status);
    expect(statuses.filter((s) => s === 401)).toEqual([]);
    expect(statuses.every((s) => s >= 400)).toBe(true);
  });

  it('Review Focus 2: email " A@X.vn " nhận ra tài khoản a@x.vn (next = sign_in)', async () => {
    const sent = captureMail();
    const known = await addMember((await createCompany()).companyId, 'sale');
    const typed = `  ${known.email.toUpperCase()} `;
    const l = await link();
    const code = await requestCode(l, typed, sent);
    expect(sent.at(-1)!.to).toBe(known.email);
    const res = await join.verify(l.token, typed, code);
    expect(res.body.next).toBe('sign_in');
    expect((await row(l.id)).email).toBe(known.email);
  });
});

describe('tham gia qua link: chạy đồng thời', () => {
  it('hai complete cùng registrationToken: một 200, một 409 invitation_used', async () => {
    const c = await claimed(uniqueEmail());
    const body = { registrationToken: c.registrationToken, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD };
    const results = await Promise.all([join.complete(body), join.complete(body)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('invitation_used');
  });

  it('sáu verify sai song song: otp_attempts dừng ở 5, không lỗi CHECK', async () => {
    const sent = captureMail();
    const l = await link();
    const email = uniqueEmail();
    const code = await requestCode(l, email, sent);
    const wrong = code === '000000' ? '111111' : '000000';
    const results = await Promise.all(Array.from({ length: 6 }, () => join.verify(l.token, email, wrong)));
    expect(results.map((r) => r.status)).toEqual([422, 422, 422, 422, 422, 422]);
    expect((await row(l.id)).otp_attempts).toBe(5);
  });

  it('hai verify đúng mã cùng lúc: đúng một nhận registrationToken', async () => {
    const sent = captureMail();
    const l = await link();
    const email = uniqueEmail();
    const code = await requestCode(l, email, sent);
    const results = await Promise.all([join.verify(l.token, email, code), join.verify(l.token, email, code)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
  });
});
