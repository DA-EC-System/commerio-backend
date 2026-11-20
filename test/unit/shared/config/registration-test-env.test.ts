import { describe, expect, it } from 'vitest';
import { registrationTestIssues } from '#src/shared/config/env.ts';

// Mã thử đăng ký cho e2e (#459, Documents/21 mục 2.1): BE từ chối khởi động khi cấu hình sai.
const base = { APP_ENV: 'staging' as const, REGISTRATION_TEST_EMAIL_DOMAIN: 'e2e.test', REGISTRATION_TEST_CODE: '123456' };

describe('registrationTestIssues', () => {
  it('không đặt gì: hợp lệ ở mọi môi trường', () => {
    expect(registrationTestIssues({ APP_ENV: 'production', REGISTRATION_TEST_EMAIL_DOMAIN: undefined, REGISTRATION_TEST_CODE: undefined })).toEqual([]);
  });

  it.each(['e2e.test', 'a.b.invalid', 'qa.example'])('miền %s ở staging, test: hợp lệ', (domain) => {
    expect(registrationTestIssues({ ...base, REGISTRATION_TEST_EMAIL_DOMAIN: domain })).toEqual([]);
    expect(registrationTestIssues({ ...base, APP_ENV: 'test', REGISTRATION_TEST_EMAIL_DOMAIN: domain })).toEqual([]);
  });

  it('chỉ đặt một biến: lỗi', () => {
    expect(registrationTestIssues({ ...base, REGISTRATION_TEST_CODE: undefined })).toHaveLength(1);
    expect(registrationTestIssues({ ...base, REGISTRATION_TEST_EMAIL_DOMAIN: undefined })).toHaveLength(1);
  });

  it.each(['production', 'development'] as const)('APP_ENV %s: lỗi', (appEnv) => {
    expect(registrationTestIssues({ ...base, APP_ENV: appEnv })).toHaveLength(1);
  });

  it.each(['gmail.com', 'test', 'e2e.test.com', 'e2e..test', '-x.test', 'e2e.testing'])('miền %s: lỗi', (domain) => {
    expect(registrationTestIssues({ ...base, REGISTRATION_TEST_EMAIL_DOMAIN: domain })).toHaveLength(1);
  });

  it.each(['12345', '1234567', 'abcdef', ' 123456'])('mã %j: lỗi', (code) => {
    expect(registrationTestIssues({ ...base, REGISTRATION_TEST_CODE: code })).toHaveLength(1);
  });
});
