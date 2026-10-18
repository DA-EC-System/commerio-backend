import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getAuth } from '#src/shared/auth/authenticate.ts';
import { errorHandler } from '#src/shared/errors/error-handler.ts';
import { validate } from '#src/shared/http/validate.ts';
import { createModuleContext } from '#src/wiring.ts';
import { addMember, createCompany, createCustomRole } from '../helpers/company.ts';
import { testPool } from '../helpers/db.ts';
import { login } from '../helpers/http.ts';
import { lockCompany, revokePermission, setModuleEnabled, suspendMembership } from '../helpers/state.ts';

// Route thử dùng đúng ctx.authorize mà app thật dùng, loader thật đọc DB (Documents/21 D1).
const { authorize } = createModuleContext();
const app = express();
app.use(express.json());
app.post(
  '/products',
  authorize('catalog.product.manage'),
  validate({ body: z.object({ name: z.string().min(1) }) }),
  (_req, res) => {
    res.json({ companyId: getAuth(res).companyId });
  },
);
app.post('/purchase-orders', authorize('purchasing.order.manage'), (_req, res) => {
  res.json({ ok: true });
});
app.use(errorHandler);

const post = (path: string, token?: string, body: object = { name: 'Áo thun' }) => {
  const req = request(app).post(path).send(body);
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};

describe('authorize trên DB thật (#8 AC-1..5)', () => {
  it('AC-1: không token hoặc token sai: 401 unauthorized', async () => {
    expect((await post('/products')).body.code).toBe('unauthorized');
    const bad = await post('/products', 'khong-phai-token');
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('unauthorized');
  });

  it('AC-2: token chưa chọn công ty: 403 company_not_selected', async () => {
    const { ceo } = await createCompany();
    const { token } = await login(ceo.email);
    const res = await post('/products', token);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('company_not_selected');
  });

  it('CEO có quyền: 200, handler chạy với công ty trong token', async () => {
    const { companyId, ceo } = await createCompany();
    const res = await post('/products', ceo.token);
    expect(res.status).toBe(200);
    expect(res.body.companyId).toBe(companyId);
  });

  it('AC-3: Sale thiếu quyền và body sai: 403 forbidden, không phải 422', async () => {
    const { companyId } = await createCompany();
    const sale = await addMember(companyId, 'sale');
    const res = await post('/products', sale.token, { name: '' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
  });

  it('AC-4: phân hệ tuỳ chọn tắt thì 403 module_disabled dù vai trò có mã quyền; bật lại thì qua', async () => {
    const { companyId, ceo } = await createCompany({ optionalModules: ['purchasing'] });
    expect((await post('/purchase-orders', ceo.token)).status).toBe(200);
    await setModuleEnabled(companyId, 'purchasing', false);
    const res = await post('/purchase-orders', ceo.token);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('module_disabled');
    await setModuleEnabled(companyId, 'purchasing', true);
    expect((await post('/purchase-orders', ceo.token)).status).toBe(200);
  });

  it('AC-5: token còn hạn, công ty bị khoá thì lần gọi kế tiếp 403 company_locked', async () => {
    const { companyId, ceo } = await createCompany();
    expect((await post('/products', ceo.token)).status).toBe(200);
    await lockCompany(companyId);
    const res = await post('/products', ceo.token);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('company_locked');
  });

  it('AC-5: membership bị khoá thì 403 account_locked', async () => {
    const { companyId } = await createCompany();
    const admin = await addMember(companyId, 'admin');
    expect((await post('/products', admin.token)).status).toBe(200);
    await suspendMembership(admin.membershipId);
    const res = await post('/products', admin.token);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('account_locked');
  });

  it('AC-5: bỏ quyền khỏi vai trò thì 403 forbidden ngay, không chờ token hết hạn (D1)', async () => {
    const { companyId } = await createCompany();
    const roleId = await createCustomRole(companyId, ['catalog.product.manage']);
    const member = await addMember(companyId, roleId);
    expect((await post('/products', member.token)).status).toBe(200);
    await revokePermission(roleId, 'catalog.product.manage');
    const res = await post('/products', member.token);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
  });

  it('token của công ty khác (đã rời công ty): 404 not_found', async () => {
    const { companyId } = await createCompany();
    const member = await addMember(companyId, 'admin');
    await testPool().query('delete from access.member_roles where membership_id = $1', [member.membershipId]);
    await testPool().query('delete from staff.memberships where id = $1', [member.membershipId]);
    const res = await post('/products', member.token);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
  });
});
