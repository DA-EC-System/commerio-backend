import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '#src/app.ts';

const app = createApp();

// API nhân viên gắn dưới /api/v1/identity (#7 [B]); phần cần DB ở test/integration/staff/members.test.ts.
describe('API nhân viên', () => {
  it.each([
    ['get', '/api/v1/identity/staff'],
    ['put', '/api/v1/identity/staff/abc/roles'],
    ['post', '/api/v1/identity/staff/abc/lock'],
    ['post', '/api/v1/identity/staff/abc/unlock'],
  ] as const)('%s %s không có token → 401 unauthorized', async (method, path) => {
    const res = await request(app)[method](path).send({});
    expect(res.status).toBe(401);
    expect(res.body.type).toBe('/problems/unauthorized');
  });

  it('không gắn router staff ở /api/v1/staff', async () => {
    expect((await request(app).get('/api/v1/staff/staff')).status).toBe(404);
  });

  it('Swagger có các đường dẫn nhân viên', async () => {
    const paths = Object.keys((await request(app).get('/api/openapi.json')).body.paths);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/api/v1/identity/staff',
        '/api/v1/identity/staff/{accountId}/roles',
        '/api/v1/identity/staff/{accountId}/lock',
        '/api/v1/identity/staff/{accountId}/unlock',
      ]),
    );
  });
});
