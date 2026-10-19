import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  type AccessLoader,
  anyOf,
  type CompanyAccess,
  createAuthorize,
  getAccess,
  moduleOfPermission,
} from '#src/shared/auth/authorize.ts';
import { signAccessToken } from '#src/shared/auth/jwt.ts';
import { errorHandler } from '#src/shared/errors/error-handler.ts';
import { validate } from '#src/shared/http/validate.ts';

const ACCOUNT = '7d1b6c1e-0000-4000-8000-000000000001';
const COMPANY = '7d1b6c1e-0000-4000-8000-0000000000c1';

const active: CompanyAccess = {
  companyStatus: 'active',
  membershipStatus: 'active',
  permissions: ['catalog.product.manage', 'purchasing.order.manage'],
  enabledModules: ['catalog', 'sales'],
  passwordChangedAt: null,
};

function buildApp(loader: AccessLoader) {
  const authorize = createAuthorize(loader);
  const handler = vi.fn((_req: express.Request, res: express.Response) => {
    res.json({ ok: true, auth: res.locals.auth });
  });
  const app = express();
  app.use(express.json());
  app.post(
    '/products',
    authorize('catalog.product.manage'),
    validate({ body: z.object({ name: z.string().min(1) }) }),
    handler,
  );
  app.post('/purchase-orders', authorize('purchasing.order.manage'), handler);
  app.post('/orders', authorize('sales.order.create'), handler);
  app.use(errorHandler);
  return { app, handler };
}

const token = (companyId: string | null = COMPANY, mustChangePassword = false) =>
  signAccessToken({ accountId: ACCOUNT, companyId, permissions: [], mustChangePassword });

async function call(loader: AccessLoader, path: string, bearer?: string, body: unknown = { name: 'Áo' }) {
  const { app, handler } = buildApp(loader);
  const req = request(app).post(path).send(body as object);
  const res = bearer ? await req.set('Authorization', `Bearer ${bearer}`) : await req;
  return { res, handler };
}

describe('createAuthorize', () => {
  it('thiếu token: 401 unauthorized, không đọc DB, handler không chạy', async () => {
    const loader = vi.fn<AccessLoader>(async () => active);
    const { res, handler } = await call(loader, '/products');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthorized');
    expect(loader).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('còn mật khẩu thư mời: 403 password_change_required', async () => {
    const { res } = await call(async () => active, '/products', await token(COMPANY, true));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('password_change_required');
  });

  it('token chưa chọn công ty: 403 company_not_selected', async () => {
    const { res } = await call(async () => active, '/products', await token(null));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('company_not_selected');
  });

  it('không còn là thành viên công ty: 404 not_found (C4)', async () => {
    const { res } = await call(async () => null, '/products', await token());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
  });

  it('token phát trước lần đổi mật khẩu: 401 unauthorized, trước cả company_locked (#62)', async () => {
    const changed = { ...active, companyStatus: 'locked' as const, passwordChangedAt: new Date() };
    const { res, handler } = await call(async () => changed, '/products', await token());
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthorized');
    expect(handler).not.toHaveBeenCalled();
  });

  it('công ty bị khoá: 403 company_locked', async () => {
    const { res } = await call(async () => ({ ...active, companyStatus: 'locked' }), '/products', await token());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('company_locked');
  });

  it('tài khoản bị khoá trong công ty: 403 account_locked', async () => {
    const loader: AccessLoader = async () => ({ ...active, membershipStatus: 'suspended' });
    const { res } = await call(loader, '/products', await token());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('account_locked');
  });

  it('vai trò có quyền nhưng phân hệ đang tắt: 403 module_disabled', async () => {
    const { res, handler } = await call(async () => active, '/purchase-orders', await token());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('module_disabled');
    expect(handler).not.toHaveBeenCalled();
  });

  it('phân hệ bật nhưng không có quyền: 403 forbidden', async () => {
    const { res } = await call(async () => active, '/orders', await token());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
  });

  it('thiếu quyền và body sai: 403 trước 422', async () => {
    const loader: AccessLoader = async () => ({ ...active, permissions: [] });
    const { res } = await call(loader, '/products', await token(), { name: '' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
  });

  it('đủ điều kiện: đọc quyền theo đúng tài khoản và công ty trong token, handler chạy', async () => {
    const loader = vi.fn<AccessLoader>(async () => active);
    const { res, handler } = await call(loader, '/products', await token());
    expect(res.status).toBe(200);
    expect(loader).toHaveBeenCalledWith(ACCOUNT, COMPANY);
    expect(handler).toHaveBeenCalledOnce();
    expect(res.body.auth).toMatchObject({ accountId: ACCOUNT, companyId: COMPANY });
  });

  it('để quyền đã đọc trong getAccess(res): handler không phải đọc DB lần hai', async () => {
    const loader = vi.fn<AccessLoader>(async () => active);
    const app = express();
    app.get('/access', createAuthorize(loader)('catalog.product.manage'), (_req, res) => {
      res.json(getAccess(res));
    });
    const res = await request(app).get('/access').set('Authorization', `Bearer ${await token()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(active);
    expect(loader).toHaveBeenCalledOnce();
  });

  it('anyOf: qua khi có một trong các quyền; thiếu cả hai thì 403 forbidden; lỗi khác không thử tiếp', async () => {
    const app = express();
    const authorize = createAuthorize(async () => active);
    const either = anyOf(authorize('sales.order.view'), authorize('catalog.product.manage'));
    const neither = anyOf(authorize('sales.order.view'), authorize('sales.order.create'));
    app.get('/either', either, (_req, res) => void res.json({ ok: true }));
    app.get('/neither', neither, (_req, res) => void res.json({ ok: true }));
    app.use(errorHandler);
    const bearer = `Bearer ${await token()}`;

    expect((await request(app).get('/either').set('Authorization', bearer)).status).toBe(200);
    const denied = await request(app).get('/neither').set('Authorization', bearer);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('forbidden');
    const anonymous = await request(app).get('/either');
    expect(anonymous.status).toBe(401);
  });

  it('getAccess ngoài route có authorize là lỗi lập trình', () => {
    expect(() => getAccess({ locals: {} } as express.Response)).toThrow(/authorize/);
  });

  it('có quyền mà body sai vẫn ra 422 như thường', async () => {
    const { res } = await call(async () => active, '/products', await token(), { name: '' });
    expect(res.status).toBe(422);
  });
});

describe('moduleOfPermission', () => {
  it('lấy phần trước dấu chấm đầu tiên', () => {
    expect(moduleOfPermission('catalog.product.view')).toBe('catalog');
    expect(moduleOfPermission('platform.audit.view')).toBe('platform');
  });
});
