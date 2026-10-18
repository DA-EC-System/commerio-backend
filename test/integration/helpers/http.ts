import type { Express } from 'express';
import request from 'supertest';
import { expect } from 'vitest';
import { createApp } from '#src/app.ts';

export const PASSWORD = 'MatKhau123';

let app: Express | undefined;

/** App thật (`createApp()`), dựng một lần cho mỗi file test. */
export function testApp(): Express {
  app ??= createApp();
  return app;
}

/** Cookie refresh `commerio_refresh=...` trong phản hồi. */
export function refreshCookie(res: request.Response): string {
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const cookie = cookies.find((c) => c.startsWith('commerio_refresh='));
  if (!cookie) throw new Error('Không có cookie refresh');
  return cookie.split(';')[0]!;
}

/** Đăng nhập; token chưa gắn công ty. */
export async function login(email: string, password = PASSWORD) {
  const res = await request(testApp()).post('/api/v1/identity/login').send({ email, password });
  expect(res.status).toBe(200);
  return { token: res.body.accessToken as string, cookie: refreshCookie(res), body: res.body };
}

/** Token đã gắn công ty. */
export async function selectCompany(token: string, companyId: string): Promise<string> {
  const res = await request(testApp())
    .post('/api/v1/identity/select-company')
    .set('Authorization', `Bearer ${token}`)
    .send({ companyId });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}
