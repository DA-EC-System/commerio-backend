import { afterEach, describe, expect, it, vi } from 'vitest';

// Ngưỡng spec 6.11 nhân 0.25: otpIp 3, otpEmail 1, completeIp 5, completeEmail 1. Mỗi test dựng app riêng.
vi.hoisted(() => {
  process.env.JOIN_RATE_LIMIT_SCALE = '0.25';
});

const { createApp } = await import('#src/app.ts');
const { BUILTIN_ROLES } = await import('#src/modules/access/domain/catalog.ts');
const { setMailTransport } = await import('#src/shared/mail/index.ts');
const { addMember, createCompany, uniqueEmail } = await import('../helpers/company.ts');
const { captureMail, codeIn, deliverOtp, joinApi, newLink } = await import('./helpers.ts');

afterEach(() => setMailTransport(null));

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
/** JWT không có chữ ký hợp lệ nhưng đọc ra được claim: kiểu token kẻ tấn công tự dựng. */
const forged = (claims: object) => `${b64url({ alg: 'EdDSA' })}.${b64url(claims)}.chu-ky-gia`;

// Bộ đếm theo email, theo lời mời chỉ tính token đã kiểm chữ ký (review bảo mật [C], I1).
describe('giới hạn tần suất của /join theo token thật', () => {
  it('token sai mang email người khác không đốt bộ đếm theo email; token thật thì có', async () => {
    captureMail();
    const app = createApp();
    const join = joinApi(app);
    const { ceo } = await createCompany();
    const victim = uniqueEmail('nan-nhan');
    expect((await join.otp('khong-phai-jwt', victim)).status).toBe(410);
    const first = await newLink(app, ceo.token, [BUILTIN_ROLES.sale.id]);
    expect((await join.otp(first.token, victim)).status).toBe(202);
    const second = await newLink(app, ceo.token, [BUILTIN_ROLES.sale.id]);
    const blocked = await join.otp(second.token, victim);
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('too_many_requests');
  });

  it('token đăng ký giả mang email người khác không đốt bộ đếm sai mật khẩu', async () => {
    const sent = captureMail();
    const app = createApp();
    const join = joinApi(app);
    const { ceo } = await createCompany();
    const known = await addMember((await createCompany()).companyId, 'sale');
    const link = await newLink(app, ceo.token, [BUILTIN_ROLES.sale.id]);
    expect((await join.otp(link.token, known.email)).status).toBe(202);
    await deliverOtp(link.id);
    const verified = await join.verify(link.token, known.email, codeIn(sent[0]!));
    expect(verified.body.next).toBe('sign_in');

    const fake = await join.complete({
      registrationToken: forged({ iss: 'commerio-join', em: known.email }),
      password: 'SaiMatKhau1',
    });
    expect(fake.status).toBe(410);
    const wrong = { registrationToken: verified.body.registrationToken as string, password: 'SaiMatKhau1' };
    expect((await join.complete(wrong)).status).toBe(422);
    expect((await join.complete(wrong)).status).toBe(429);
  });
});
