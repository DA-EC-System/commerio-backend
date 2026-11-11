import { describe, expect, it } from 'vitest';
import { signUpload, type StorageConfig } from '#src/modules/core/files/service/storage.ts';

// Ký URL chỉ tính trong máy: không gọi mạng.
const config: StorageConfig = {
  endpoint: 'https://test-account.r2.cloudflarestorage.com',
  region: 'auto',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  buckets: { public: 'commerio-test-public', private: 'commerio-test-private' },
  keyPrefix: 'test',
};

async function sign() {
  const signed = await signUpload(
    config,
    { bucket: 'commerio-test-private', key: 'test/abc.pdf', contentType: 'application/pdf', sizeBytes: 2048 },
    900,
  );
  return { ...signed, parsed: new URL(signed.url) };
}

describe('signUpload: URL PUT ký sẵn (Documents/21 §14.3)', () => {
  it('ký Content-Type và Content-Length để kho từ chối tệp khác kiểu hoặc to hơn đã khai', async () => {
    const { parsed } = await sign();
    expect(parsed.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual(
      expect.arrayContaining(['content-length', 'content-type', 'host']),
    );
  });

  it('trả đúng hai header FE phải gửi', async () => {
    const { headers } = await sign();
    expect(headers).toEqual({ 'Content-Type': 'application/pdf', 'Content-Length': '2048' });
  });

  it('hết hạn sau số giây truyền vào', async () => {
    const { parsed } = await sign();
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('900');
  });

  it('không gắn checksum của thân rỗng (kho sẽ từ chối tệp thật)', async () => {
    const { parsed } = await sign();
    const names = [...parsed.searchParams.keys()].map((k) => k.toLowerCase());
    expect(names.some((k) => k.startsWith('x-amz-checksum') || k === 'x-amz-sdk-checksum-algorithm')).toBe(false);
  });

  it('trỏ tới đúng bucket và tên tệp', async () => {
    const { parsed } = await sign();
    expect(`${parsed.host}${parsed.pathname}`).toContain('commerio-test-private');
    expect(parsed.pathname.endsWith('/test/abc.pdf')).toBe(true);
  });
});
