import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type * as EnvModule from '#src/shared/config/env.ts';

// `settlements/dev/import` không gắn khi NODE_ENV=production (plan #30 A2, AC-12): route không tồn tại → 404 trước cả
// kiểm token. Env đọc một lần lúc import nên thay module env.
vi.mock('#src/shared/config/env.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof EnvModule>();
  return { ...actual, env: { ...actual.env, NODE_ENV: 'production' } };
});

describe('POST /finance/settlements/dev/import ở production', () => {
  it('404, không phải 401', async () => {
    const { createApp } = await import('#src/app.ts');
    const res = await request(createApp()).post('/api/v1/finance/settlements/dev/import');
    expect(res.status).toBe(404);
  }, 30_000); // nạp cả app động: chậm khi chạy song song với cả project
});
