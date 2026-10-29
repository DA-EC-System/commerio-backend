import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { grantPlatformAdmin, revokePlatformAdmin } from '../../../db/seed/platform-admin.ts';
import { registerCompany, uniqueEmail } from '../helpers/company.ts';
import { login, PASSWORD, testApp } from '../helpers/http.ts';

// Cấp, gỡ quyền quản trị nền tảng bằng `npm run platform-admin` (#152).

const overview = (token: string) =>
  request(testApp()).get('/api/v1/platform/overview').set('Authorization', `Bearer ${token}`);

describe('platform-admin', () => {
  it('tạo tài khoản mới có cờ, đăng nhập được vào trang quản trị; chạy lại không đổi gì', async () => {
    const email = uniqueEmail('qtnt');
    expect(await grantPlatformAdmin({ email: email.toUpperCase(), password: PASSWORD })).toBe('created');
    const { token, body } = await login(email);
    expect(body.memberships ?? []).toEqual([]);
    expect((await overview(token)).status).toBe(200);
    expect(await grantPlatformAdmin({ email })).toBe('unchanged');
  });

  it('gỡ cờ: request kế tiếp bị chặn', async () => {
    const email = uniqueEmail('qtnt');
    await grantPlatformAdmin({ email, password: PASSWORD });
    const { token } = await login(email);
    expect(await revokePlatformAdmin(email)).toBe('revoked');
    expect((await overview(token)).status).toBe(403);
    expect(await revokePlatformAdmin(email)).toBe('unchanged');
  });

  it('từ chối tài khoản đang thuộc công ty, mật khẩu yếu, tài khoản chưa có mà thiếu mật khẩu', async () => {
    const { email } = await registerCompany();
    await expect(grantPlatformAdmin({ email })).rejects.toThrow('thuộc một công ty');
    await expect(grantPlatformAdmin({ email: uniqueEmail('qtnt'), password: 'ngan' })).rejects.toThrow('8 ký tự');
    await expect(grantPlatformAdmin({ email: uniqueEmail('qtnt') })).rejects.toThrow('PLATFORM_ADMIN_PASSWORD');
    await expect(revokePlatformAdmin(uniqueEmail('khong-co'))).rejects.toThrow('Không có tài khoản');
  });
});
