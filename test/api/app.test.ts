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

  it('đủ 19 module, tên không trùng', () => {
    const names = modules.map((m) => m.name);
    expect(names).toHaveLength(19);
    expect(new Set(names).size).toBe(19);
  });
});
