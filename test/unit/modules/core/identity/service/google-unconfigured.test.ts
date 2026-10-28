import { describe, expect, it, vi } from 'vitest';

// File riêng: env đọc một lần lúc import, nên bỏ GOOGLE_CLIENT_ID trước khi nạp module.
vi.hoisted(() => {
  delete process.env.GOOGLE_CLIENT_ID;
});

const { verifyGoogleCredential } = await import('#src/modules/core/identity/service/google.ts');

describe('máy chủ chưa cấu hình Google', () => {
  it('thiếu GOOGLE_CLIENT_ID → 503 google_unavailable, không coi là token sai', async () => {
    await expect(verifyGoogleCredential('a.b.c-khong-quan-trong-noi-dung')).rejects.toMatchObject({
      status: 503,
      code: 'google_unavailable',
    });
  });
});
