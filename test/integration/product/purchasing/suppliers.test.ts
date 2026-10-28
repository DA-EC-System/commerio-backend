import { beforeAll, describe, expect, it } from 'vitest';
import { Supplier, SupplierList } from '#src/modules/product/purchasing/api/schemas.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { BUYER_ROLE, createSupplier, pur } from './helpers.ts';

// Nhà cung cấp /purchasing/suppliers (Documents/21 mục 16.2, spec #108).
let A: { companyId: string; ceo: string; buyer: string; kho: string };
let B: { ceo: string };

beforeAll(async () => {
  const a = await createCompany();
  A = {
    companyId: a.companyId,
    ceo: a.ceo.token,
    buyer: (await addMember(a.companyId, BUYER_ROLE)).token,
    kho: (await addMember(a.companyId, 'warehouse')).token,
  };
  B = { ceo: (await createCompany()).ceo.token };
});

describe('nhà cung cấp', () => {
  it('mua hàng thêm NCC: 201, trường trống trả chuỗi rỗng, đúng schema', async () => {
    const res = await pur(A.buyer).post('/suppliers', { name: '  Công ty Vải Sài Gòn ', phone: '0901 234 567' });
    expect(res.status).toBe(201);
    const s = Supplier.parse(res.body);
    expect(s).toMatchObject({ name: 'Công ty Vải Sài Gòn', phone: '0901 234 567', email: '', note: '', active: true, version: 1 });
  });

  it('tên trùng (khác hoa thường) trả 422 errors.name', async () => {
    const { name } = await createSupplier(A.ceo);
    const res = await pur(A.ceo).post('/suppliers', { name: name.toUpperCase() });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual({ name: 'Đã có nhà cung cấp tên này' });
  });

  it('email, số điện thoại sai định dạng trả 422 theo ô', async () => {
    const res = await pur(A.ceo).post('/suppliers', { name: 'NCC sai', email: 'khong-phai-email', phone: 'abc' });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.errors).sort()).toEqual(['email', 'phone']);
  });

  it('sửa với version cũ trả 409 version_conflict kèm bản mới nhất', async () => {
    const s = await createSupplier(A.ceo);
    const ok = await pur(A.ceo).put(`/suppliers/${s.id}`, { name: s.name, note: 'Giao thứ Hai', version: 1 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ note: 'Giao thứ Hai', version: 2 });
    const stale = await pur(A.ceo).put(`/suppliers/${s.id}`, { name: s.name, version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');
    expect(stale.body.current).toMatchObject({ id: s.id, version: 2 });
  });

  it('lọc active=true bỏ NCC đã ngừng giao dịch', async () => {
    const s = await createSupplier(A.ceo);
    await pur(A.ceo).put(`/suppliers/${s.id}`, { name: s.name, active: false, version: 1 });
    const all = SupplierList.parse((await pur(A.ceo).get('/suppliers')).body);
    const active = SupplierList.parse((await pur(A.ceo).get('/suppliers?active=true')).body);
    expect(all.map((x) => x.id)).toContain(s.id);
    expect(active.map((x) => x.id)).not.toContain(s.id);
  });

  it('kho xem được danh sách nhưng không thêm được (403)', async () => {
    expect((await pur(A.kho).get('/suppliers')).status).toBe(200);
    expect((await pur(A.kho).post('/suppliers', { name: 'NCC của kho' })).status).toBe(403);
  });

  it('NCC của công ty khác trả 404', async () => {
    const s = await createSupplier(A.ceo);
    const res = await pur(B.ceo).put(`/suppliers/${s.id}`, { name: 'Đổi tên', version: 1 });
    expect(res.status).toBe(404);
  });
});
