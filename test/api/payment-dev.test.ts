import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type * as EnvModule from '#src/shared/config/env.ts';

// `dev/simulate` không gắn khi NODE_ENV=production (Documents/21 §12.11; plan #27 A12, AC-21): route không tồn tại → 404
// trước cả kiểm token. Env đọc một lần lúc import nên thay module env.
vi.mock('#src/shared/config/env.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof EnvModule>();
  return { ...actual, env: { ...actual.env, NODE_ENV: 'production' } };
});

describe('POST /payment/dev/simulate ở production', () => {
  it('404 not_found, không phải 401', async () => {
    const { createApp } = await import('#src/app.ts');
    const res = await request(createApp()).post('/api/v1/payment/dev/simulate/CMABCDEFGHJK');
    expect(res.status).toBe(404);
  }, 30_000); // nạp cả app động: chậm khi chạy song song với cả project
});
