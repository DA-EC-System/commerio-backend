import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { type AccessLoader, type CompanyAccess, createAuthorize, moduleOfPermission } from '#src/shared/auth/authorize.ts';
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
