import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createHub, createRealtimeApp } from '#src/modules/core/notification/index.ts';

// Cổng stream của realtime chỉ phục vụ kênh SSE; /health và /metrics nằm ở cổng vận hành riêng (REALTIME_OPS_PORT),
// như api và worker (src/entrypoints/CLAUDE.md).
describe('createRealtimeApp', () => {
  it.each(['/metrics', '/health'])('không phục vụ %s trên cổng stream', async (path) => {
    const res = await request(createRealtimeApp({ hub: createHub() })).get(path);
    expect(res.status).toBe(404);
  });

  it('stream vẫn ở /api/v1/notification/stream (thiếu token → 401)', async () => {
    const res = await request(createRealtimeApp({ hub: createHub() })).get('/api/v1/notification/stream');
    expect(res.status).toBe(401);
  });
});
