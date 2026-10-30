import request from 'supertest';
import { expect, it } from 'vitest';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';

it('context trả quyền tự duyệt theo công ty, không suy từ quyền duyệt hoặc tên vai trò', async () => {
  const company = await createCompany();
  const admin = await addMember(company.companyId, 'admin');
  const context = async (token: string) => {
    const res = await request(testApp()).post('/api/v1/identity/select-company')
      .set('Authorization', `Bearer ${token}`).send({ companyId: company.companyId });
    expect(res.status).toBe(200);
    return res.body.context;
  };
  expect((await context(company.ceo.token)).canSelfApprove).toBe(true);
  expect((await context(admin.token)).canSelfApprove).toBe(false);
  // Chỉ còn Admin hoạt động: quyền tính lại ngay khi chọn công ty.
  await testPool().query('update core.memberships set status = $1 where company_id = $2 and account_id <> $3', ['suspended', company.companyId, admin.accountId]);
  expect((await context(admin.token)).canSelfApprove).toBe(true);
  await createCompany();
  expect((await context(admin.token)).canSelfApprove).toBe(true);
});
