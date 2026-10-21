import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

// Ngưỡng nhỏ để chạm được giới hạn (spec 6.11 nhân 0.2): otpIp 2, otpEmail 1. Mỗi test dựng app riêng nên bộ đếm
// không dồn sang nhau. Các ca ở đây không chạm DB: token sai bị chặn trước khi đọc lời mời.
vi.hoisted(() => {
  process.env.JOIN_RATE_LIMIT_SCALE = '0.2';
});

const { createApp } = await import('#src/app.ts');
const { signAccessToken } = await import('#src/shared/auth/jwt.ts');
const { signPurposeToken } = await import('#src/shared/auth/purpose-token.ts');

const post = (path: string, body: object) => request(createApp()).post(`/api/v1/identity/join/${path}`).send(body);

const wrongTokens = async () => [
  'khong-phai-jwt',
  await signAccessToken({
    accountId: randomUUID(),
    companyId: randomUUID(),
    permissions: [],
    mustChangePassword: false,
    passwordChangedAt: null,
  }),
  await signPurposeToken('join', { jti: randomUUID(), cid: randomUUID(), em: 'a@x.vn', nxt: 'set_password' }),
];

// API công khai cho người được mời (#7 [C], spec 6.5, 6.11). Phần cần DB ở test/integration/staff/join-*.test.ts.
describe('API tham gia qua link', () => {
  it('AC-C3: chuỗi bất kỳ, access token, token đăng ký dùng làm link → 410 invitation_invalid ở check, otp, verify', async () => {
    for (const token of await wrongTokens()) {
      for (const [path, body] of [
        ['check', { token }],
        ['otp', { token, email: 'a@x.vn', fullName: 'Người Được Mời' }],
        ['verify', { token, email: 'a@x.vn', code: '123456' }],
      ] as const) {
        const res = await post(path, body);
        expect(res.status, path).toBe(410);
        expect(res.body.type).toBe('/problems/invitation_invalid');
      }
    }
  });

  it('AC-C11: registrationToken sai, hay là token link → 410 registration_expired', async () => {
    const invite = await signPurposeToken('invite', { jti: randomUUID(), cid: randomUUID() });
    for (const registrationToken of ['khong-phai-jwt', invite]) {
      const res = await post('complete', { registrationToken, password: 'MatKhau123', confirmPassword: 'MatKhau123' });
      expect(res.status).toBe(410);
      expect(res.body.type).toBe('/problems/registration_expired');
    }
  });

  it('body sai → 422 theo ô, trước khi kiểm token', async () => {
    const otp = await post('otp', { token: 'khong-phai-jwt', email: 'khong-phai-email', fullName: 'A' });
    expect(otp.status).toBe(422);
    expect(Object.keys(otp.body.errors).sort()).toEqual(['email', 'fullName']);
    const verify = await post('verify', { token: 'khong-phai-jwt', email: 'a@x.vn', code: '12ab' });
    expect(Object.keys(verify.body.errors)).toEqual(['code']);
    const weak = await post('complete', { registrationToken: 'khong-phai-jwt', password: 'ngan' });
    expect(weak.status).toBe(422);
    expect(Object.keys(weak.body.errors)).toEqual(['password']);
    const mismatch = await post('complete', {
      registrationToken: 'khong-phai-jwt',
      password: 'MatKhau123',
      confirmPassword: 'MatKhau124',
    });
    expect(Object.keys(mismatch.body.errors)).toEqual(['confirmPassword']);
  });

  it('AC-C5: vượt giới hạn theo IP → 429 too_many_requests kèm Retry-After, dù token sai', async () => {
    const app = createApp();
    const otp = (email: string) =>
      request(app)
        .post('/api/v1/identity/join/otp')
        .send({ token: 'khong-phai-jwt', email, fullName: 'Người Được Mời' });
    // Token sai không tính vào bộ đếm theo email (chỉ token thật mới tính): cùng email vẫn tới service.
    expect((await otp('a@x.vn')).status).toBe(410);
    expect((await otp(' A@X.vn ')).status).toBe(410);
    const byIp = await otp('b@x.vn');
    expect(byIp.status).toBe(429);
    expect(byIp.body).toMatchObject({ type: '/problems/too_many_requests', status: 429, code: 'too_many_requests' });
    expect(Number(byIp.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('Swagger có các đường dẫn tham gia và lời mời', async () => {
    const paths = Object.keys((await request(createApp()).get('/api/openapi.json')).body.paths);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/api/v1/identity/join/check',
        '/api/v1/identity/join/otp',
        '/api/v1/identity/join/verify',
        '/api/v1/identity/join/complete',
        '/api/v1/identity/invitations',
        '/api/v1/identity/invitations/{id}/approve',
        '/api/v1/identity/invitations/{id}/reject',
      ]),
    );
  });
});
