import express from 'express';
import { generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticate, getAuth } from '#src/shared/auth/authenticate.ts';
import { signAccessToken } from '#src/shared/auth/jwt.ts';
import { errorHandler } from '#src/shared/errors/error-handler.ts';

function buildApp(allowPasswordChange = false) {
  const app = express();
  app.get('/private', authenticate({ allowPasswordChange }), (_req, res) => {
    res.json(getAuth(res));
  });
  app.use(errorHandler);
  return app;
}

const claims = { accountId: '7d1b6c1e-0000-4000-8000-000000000001', companyId: null, permissions: [], mustChangePassword: false, passwordChangedAt: null };

afterEach(() => {
  vi.useRealTimers();
});

describe('authenticate', () => {
  it('token hợp lệ thì đưa thông tin người gọi vào res.locals.auth', async () => {
    const token = await signAccessToken({ ...claims, companyId: 'c1', permissions: ['catalog.product.view'] });
    const res = await request(buildApp()).get('/private').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ...claims,
      companyId: 'c1',
      permissions: ['catalog.product.view'],
      expiresAt: expect.any(Number),
    });
  });

  it('thiếu header hoặc không phải Bearer thì 401 unauthorized', async () => {
    for (const header of [undefined, 'Basic abc']) {
      const req = request(buildApp()).get('/private');
      const res = header ? await req.set('Authorization', header) : await req;
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('unauthorized');
    }
  });

  it('token ký bằng khoá khác thì 401', async () => {
    const { privateKey } = await generateKeyPair('EdDSA');
    const forged = await new SignJWT({}).setProtectedHeader({ alg: 'EdDSA' }).setIssuer('commerio').setSubject('x').setExpirationTime('5m').sign(privateKey);
    const res = await request(buildApp()).get('/private').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it('token quá 15 phút thì 401', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const token = await signAccessToken(claims);
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    const res = await request(buildApp()).get('/private').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('còn mật khẩu thư mời thì 403 password_change_required, trừ route cho phép', async () => {
    const token = await signAccessToken({ ...claims, mustChangePassword: true });
    const blocked = await request(buildApp()).get('/private').set('Authorization', `Bearer ${token}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('password_change_required');
    const allowed = await request(buildApp(true)).get('/private').set('Authorization', `Bearer ${token}`);
    expect(allowed.status).toBe(200);
  });
});
