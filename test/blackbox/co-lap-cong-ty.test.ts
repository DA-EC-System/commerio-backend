import { beforeAll, describe, expect, inject, it } from 'vitest';
import { api } from './lib/client.ts';
import { expectProblem } from './lib/contract.ts';
import { act, newRequest, newSupplier, newVariant } from './lib/fixtures.ts';

// Cô lập công ty (Documents/26 §4): CEO công ty B dùng id bản ghi của công ty A thì nhận 404 `not_found`, không phải
// 403, và danh sách của B không có bản ghi của A. Mỗi module mới thêm một ca vào đây.

const tokens = inject('tokens');
const b = () => api(tokens.ceoB);
let ids: { variant: string; product: string; supplier: string; request: string; requestVersion: number; staff: string };

beforeAll(async () => {
  const variant = await newVariant(tokens.ceo);
  const supplier = await newSupplier(tokens.ceo);
  const request = await newRequest(tokens.buyer, supplier, variant);
  const products = await api(tokens.ceo).get('/catalog/products?pageSize=1');
  const staff = await api(tokens.ceo).get('/identity/staff?pageSize=1');
  ids = {
    variant,
    product: products.body.items[0].id,
    supplier,
    request: request.id,
    requestVersion: request.version,
    staff: staff.body.items[0].accountId,
  };
});

describe('cô lập công ty: đọc, ghi bằng id của công ty khác', () => {
  it('ISO-01: đề nghị nhập của A: xem, thao tác, sửa đều 404', async () => {
    expectProblem(await b().get(`/purchasing/requests/${ids.request}`), 404, 'not_found');
    expectProblem(await act(tokens.ceoB, ids.request, 'cancel', { version: ids.requestVersion }), 404, 'not_found');
    const still = await api(tokens.ceo).get(`/purchasing/requests/${ids.request}`);
    expect([still.body.status, still.body.version]).toEqual(['draft', ids.requestVersion]);
  });

  it('ISO-02: nhà cung cấp, sản phẩm, tồn của A đều 404', async () => {
    expectProblem(await b().put(`/purchasing/suppliers/${ids.supplier}`, { name: 'Đổi tên từ công ty B', version: 1 }), 404, 'not_found');
    expectProblem(await b().get(`/catalog/products/${ids.product}`), 404, 'not_found');
    expectProblem(await b().get(`/inventory/stock/${ids.variant}`), 404, 'not_found');
  });

  it('ISO-03: đề nghị của B không dùng được NCC, biến thể của A', async () => {
    const res = await b().post('/purchasing/requests', { supplierId: ids.supplier, note: '', lines: [{ variantId: ids.variant, quantity: 1, unitCost: 1000 }] });
    expect([404, 422], JSON.stringify(res.body)).toContain(res.status);
  });

  it('ISO-04: nhân viên của A: đổi vai trò, khoá từ công ty B nhận 404', async () => {
    expectProblem(await b().post(`/identity/staff/${ids.staff}/lock`, { version: 1 }), 404, 'not_found');
  });

  it('ISO-05: danh sách của B không có bản ghi nào của A', async () => {
    const requests = await b().get('/purchasing/requests?pageSize=100');
    expect(requests.body.items.map((r: { id: string }) => r.id)).not.toContain(ids.request);
    const suppliers = await b().get('/purchasing/suppliers');
    const supplierIds = (Array.isArray(suppliers.body) ? suppliers.body : suppliers.body.items).map((s: { id: string }) => s.id);
    expect(supplierIds).not.toContain(ids.supplier);
    const staff = await b().get('/identity/staff?pageSize=100');
    expect(staff.body.items.map((s: { accountId: string }) => s.accountId)).not.toContain(ids.staff);
  });
});
