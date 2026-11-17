import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { responsibleOrgOf } from '#src/modules/core/index.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';

// Hồ sơ công ty: tổ chức chịu trách nhiệm hàng hoá (#292, Documents/21 mục 4 M7, 11.3).

const as = (token: string) => ({
  get: () => request(testApp()).get('/api/v1/platform/company').set('Authorization', `Bearer ${token}`),
  put: (body: object) => request(testApp()).put('/api/v1/platform/company').set('Authorization', `Bearer ${token}`).send(body),
});

describe('GET/PUT /platform/company', () => {
  it('chưa điền: tổ chức chịu trách nhiệm theo tên công ty, địa chỉ null (AC-2)', async () => {
    const { companyId, ceo } = await createCompany();
    const res = await as(ceo.token).get();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: companyId, address: null, responsibleName: null, responsibleAddress: null, version: 1 });
    expect(res.body.effectiveResponsible).toEqual({ name: res.body.name, address: null });
  });

  it('sửa địa chỉ đăng ký: đọc lại thấy giá trị mới, version tăng, địa chỉ hiệu lực theo (AC-1, AC-2)', async () => {
    const { companyId, ceo } = await createCompany();
    const res = await as(ceo.token).put({ address: '  12 Lý Thường Kiệt, Q.10, TP.HCM ', version: 1 });
    expect(res.status).toBe(200);
    const read = (await as(ceo.token).get()).body;
    expect(read).toMatchObject({ address: '12 Lý Thường Kiệt, Q.10, TP.HCM', version: 2 });
    expect(read.effectiveResponsible.address).toBe('12 Lý Thường Kiệt, Q.10, TP.HCM');
    expect(await responsibleOrgOf(companyId)).toEqual(read.effectiveResponsible);
  });

  it('Admin ghi đè tổ chức chịu trách nhiệm rồi đặt null thì quay về mặc định (AC-1, AC-2, AC-5)', async () => {
    const { companyId } = await createCompany();
    const admin = await addMember(companyId, 'admin');
    const set = await as(admin.token).put({ responsibleName: 'Cty Nhập Khẩu A', responsibleAddress: '1 Lê Lợi', version: 1 });
    expect(set.status).toBe(200);
    expect(await responsibleOrgOf(companyId)).toEqual({ name: 'Cty Nhập Khẩu A', address: '1 Lê Lợi' });

    const reset = await as(admin.token).put({ responsibleName: null, responsibleAddress: null, version: 2 });
    expect(reset.body.effectiveResponsible).toEqual({ name: reset.body.name, address: null });
    expect((await as(admin.token).get()).body).toMatchObject({ responsibleName: null, responsibleAddress: null, version: 3 });
  });

  it('401 không token, 403 Sale thiếu quyền trước validate, 422 chuỗi rỗng, 409 version cũ kèm current (AC-3)', async () => {
    const { companyId, ceo } = await createCompany();
    const sale = await addMember(companyId, 'sale');
    expect((await request(testApp()).get('/api/v1/platform/company')).status).toBe(401);
    expect((await as(sale.token).put({ address: '' })).body.type).toBe('/problems/forbidden');

    const bad = await as(ceo.token).put({ responsibleName: '   ', version: 1 });
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toHaveProperty('responsibleName');

    await as(ceo.token).put({ address: 'A', version: 1 });
    const stale = await as(ceo.token).put({ address: 'B', version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.type).toBe('/problems/version_conflict');
    expect(stale.body.current).toMatchObject({ address: 'A', version: 2 });
    expect((await as(ceo.token).get()).body.address).toBe('A');
    expect((await as(ceo.token).put({ version: 2 })).body.version).toBe(2);
  });

  it('ghi nhật ký công ty chỉ các ô đổi; trang nhật ký nền tảng không lấy dòng này (AC-4)', async () => {
    const { companyId, ceo } = await createCompany();
    await as(ceo.token).put({ responsibleName: 'Cty B', version: 1 });
    const log = await testPool().query(
      `select company_id, action, before, after from core.audit_logs
       where entity_type = 'core.companies' and entity_id = $1 and action = 'update'`,
      [companyId],
    );
    expect(log.rows).toEqual([
      { company_id: companyId, action: 'update', before: { responsibleName: null }, after: { responsibleName: 'Cty B' } },
    ]);
    // Gửi lại đúng giá trị cũ cùng một ô mới: chỉ ô mới vào nhật ký; gửi toàn giá trị cũ thì không tăng version, không ghi.
    await as(ceo.token).put({ responsibleName: 'Cty B', address: '1 Lê Lợi', version: 2 });
    expect((await as(ceo.token).put({ responsibleName: 'Cty B', version: 3 })).body.version).toBe(3);
    const logs = await testPool().query(
      `select before, after from core.audit_logs where entity_type = 'core.companies' and entity_id = $1 and action = 'update' order by id`,
      [companyId],
    );
    expect(logs.rows.slice(1)).toEqual([{ before: { address: null }, after: { address: '1 Lê Lợi' } }]);
    const platformLog = await testPool().query(
      `select count(*)::int as n from core.audit_logs a where a.entity_type = 'core.companies' and a.entity_id = $1
       and (a.action = 'create' or a.after->>'status' in ('locked', 'active'))`,
      [companyId],
    );
    expect(platformLog.rows[0].n).toBe(1);
  });
});
