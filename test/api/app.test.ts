import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '#src/app.ts';
import { modules } from '#src/modules/registry.ts';

const app = createApp();

describe('khung api', () => {
  it('GET /health trả 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('không lộ /metrics trên cổng API', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(404);
  });

  it('đường dẫn không có trả 404 dạng Problem Details', async () => {
    const res = await request(app).get('/khong-ton-tai');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ type: '/problems/not_found', code: 'not_found', status: 404, instance: '/khong-ton-tai' });
  });

  it('JSON hỏng trả 400', async () => {
    const res = await request(app).post('/health').set('content-type', 'application/json').send('{hong');
    expect(res.status).toBe(400);
    expect(res.body.type).toBe('/problems/malformed_json');
  });

  it('thân JSON quá 1 MB trả 413 payload_too_large, kể cả khi chưa đăng nhập', async () => {
    const res = await request(app)
      .post('/api/v1/identity/me')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ x: 'a'.repeat(1_100_000) }));
    expect(res.status).toBe(413);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ type: '/problems/payload_too_large', code: 'payload_too_large', status: 413 });
  });

  it('GET /api/openapi.json trả tài liệu OpenAPI 3.1 có /health', async () => {
    const res = await request(app).get('/api/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.paths).toHaveProperty('/health');
  });

  it('GET /api/docs/ trả trang Swagger UI', async () => {
    const res = await request(app).get('/api/docs/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('tin proxy đúng số tầng TRUST_PROXY_HOPS, mặc định 0', () => {
    expect(app.get('trust proxy')).toBe(0);
  });

  it('module đã gắn router rỗng vẫn trả 404 Problem Details cho đường dẫn chưa có (AC-12)', async () => {
    const mounted = modules.filter((m) => m.router).map((m) => m.name);
    expect(mounted).toEqual(expect.arrayContaining(['catalog', 'pricing', 'inventory', 'sales', 'payment', 'finance', 'platform', 'staff', 'files']));
    for (const name of mounted) {
      const res = await request(app).get(`/api/v1/${name}/khong-ton-tai`);
      expect(res.status, name).toBe(404);
      expect(res.body.code).toBe('not_found');
    }
  });

  it('đủ 19 module, tên không trùng', () => {
    const names = modules.map((m) => m.name);
    expect(names).toHaveLength(19);
    expect(new Set(names).size).toBe(19);
  });
});
