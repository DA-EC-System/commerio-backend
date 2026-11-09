import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { PurchaseRequest, PurchaseRequestPage } from '#src/modules/product/purchasing/api/schemas.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany, createCustomRole } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { raceBehindLock } from '../../helpers/locks.ts';
import { inv } from '../inventory/helpers.ts';
import { act, createRequest, createSupplier, pur, runActions } from './helpers.ts';

// Đề nghị nhập /purchasing/requests (Documents/21 mục 16.2, 16.3; spec #108 mục 11).
let A: { companyId: string; ceo: string; requester: string; receiver: string; supplierId: string; v1: string; v2: string; categoryId: string };
let B: { ceo: string };

beforeAll(async () => {
  const a = await createCompany();
  const first = await createVariant(a.companyId);
  A = {
    companyId: a.companyId,
    ceo: a.ceo.token,
    requester: (await addMember(a.companyId, 'warehouse')).token,
    // Chỉ nhận hàng (purchasing.receipt.manage): xem được đề nghị nhưng không thấy giá. Nhân viên kho có sẵn nay lập được đề nghị nên thấy giá.
    receiver: (await addMember(a.companyId, await createCustomRole(a.companyId, ['purchasing.receipt.manage']))).token,
    supplierId: (await createSupplier(a.ceo.token)).id,
    v1: first.variantId,
    v2: (await createVariant(a.companyId)).variantId,
    categoryId: first.categoryId,
  };
  B = { ceo: (await createCompany()).ceo.token };
});

const newName = () => `Áo mới ${randomUUID().slice(0, 8)}`;

describe('lập và sửa đề nghị', () => {
  it('Kho lập đề nghị một SKU có sẵn và một sản phẩm mới: 201, số DN-000001, nháp, có lịch sử', async () => {
    const c = await createCompany();
    const kho = (await addMember(c.companyId, 'warehouse')).token;
    const { variantId, categoryId } = await createVariant(c.companyId);
    const supplier = await createSupplier(c.ceo.token);
    const res = await pur(kho).post('/requests', {
      supplierId: supplier.id,
      note: 'Hàng thu đông',
      lines: [
        { variantId, quantity: 10, unitCost: 120000 },
        { newProduct: { name: 'Áo khoác gió', categoryId }, quantity: 5, unitCost: 200000 },
      ],
    });
    expect(res.status).toBe(201);
    const body = PurchaseRequest.parse(res.body);
    expect(body).toMatchObject({
      number: 'DN-000001',
      status: 'draft',
      supplier: { id: supplier.id },
      lineCount: 2,
      totalQty: 15,
      totalCost: 2200000,
      outstanding: 15,
      supplierShort: false,
    });
    expect(body.lines[1]).toMatchObject({ variantId: null, sku: null, productName: 'Áo khoác gió', newProduct: { categoryId } });
    expect(body.statusHistory).toEqual([expect.objectContaining({ from: null, to: 'draft', source: 'user' })]);
  });

  it('NCC ngừng giao dịch, SKU ngừng nhập, SKU lặp, tên sản phẩm mới đã có: 422 đúng ô', async () => {
    const stopped = await createSupplier(A.ceo);
    await pur(A.ceo).put(`/suppliers/${stopped.id}`, { name: stopped.name, active: false, version: 1 });
    const { variantId: discontinued } = await createVariant(A.companyId);
    await testPool().query("update product.product_variants set business_status = 'discontinued' where id = $1", [discontinued]);
    const [taken] = (await testPool().query<{ name: string }>('select name from product.products where company_id = $1 limit 1', [A.companyId])).rows;
    const res = await pur(A.requester).post('/requests', {
      supplierId: stopped.id,
      lines: [
        { variantId: discontinued, quantity: 1, unitCost: 1000 },
        { variantId: A.v1, quantity: 1, unitCost: 1000 },
        { variantId: A.v1, quantity: 2, unitCost: 1000 },
        { newProduct: { name: taken!.name, categoryId: A.categoryId }, quantity: 1, unitCost: 1000 },
      ],
    });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual({
      supplierId: 'Nhà cung cấp đã ngừng giao dịch',
      'lines.0.variantId': 'SKU đã ngừng nhập',
      'lines.2.variantId': 'Sản phẩm bị lặp',
      'lines.3.newProduct.name': 'Đã có sản phẩm cùng tên',
    });
  });

  it('dòng vừa có SKU vừa có sản phẩm mới, hoặc không có gì: 422', async () => {
    const res = await pur(A.requester).post('/requests', {
      supplierId: A.supplierId,
      lines: [{ quantity: 1, unitCost: 1000 }],
    });
    expect(res.status).toBe(422);
    expect(res.body.errors['lines.0.variantId']).toBeDefined();
  });

  it('sửa nháp thay toàn bộ dòng; sửa khi đang chờ duyệt: 409 not_draft; version cũ: 409 kèm current', async () => {
    const r = await createRequest(A.requester, A.supplierId, [{ variantId: A.v1, quantity: 3, unitCost: 1000 }]);
    const ok = await pur(A.requester).put(`/requests/${r.id}`, {
      supplierId: A.supplierId,
      note: 'Sửa',
      lines: [{ variantId: A.v2, quantity: 4, unitCost: 2000 }],
      version: r.version,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.lines).toEqual([expect.objectContaining({ variantId: A.v2, quantity: 4 })]);

    const stale = await pur(A.requester).put(`/requests/${r.id}`, {
      supplierId: A.supplierId,
      lines: [{ variantId: A.v2, quantity: 1, unitCost: 1 }],
      version: r.version,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');
    expect(stale.body.current).toMatchObject({ id: r.id, version: ok.body.version });

    const submitted = await act(A.requester, r.id, 'submit', { version: ok.body.version });
    expect(submitted.status).toBe(200);
    const locked = await pur(A.requester).put(`/requests/${r.id}`, {
      supplierId: A.supplierId,
      lines: [{ variantId: A.v2, quantity: 1, unitCost: 1 }],
      version: submitted.body.version,
    });
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('not_draft');
  });

  it('danh sách phân trang, tìm theo số đề nghị, đúng schema', async () => {
    const r = await createRequest(A.requester, A.supplierId, [{ variantId: A.v1, quantity: 1, unitCost: 1000 }]);
    const res = await pur(A.receiver).get(`/requests?search=${r.number}&pageSize=5`);
    expect(res.status).toBe(200);
    const page = PurchaseRequestPage.parse(res.body);
    expect(page.items.map((i) => i.id)).toEqual([r.id]);
    expect(page.items[0]!.totalCost).toBeNull(); // chỉ nhận hàng, không thấy giá
  });

  it('người chỉ nhận hàng xem chi tiết không thấy giá; công ty khác nhận 404', async () => {
    const r = await createRequest(A.requester, A.supplierId, [{ variantId: A.v1, quantity: 2, unitCost: 5000 }]);
    const byReceiver = PurchaseRequest.parse((await pur(A.receiver).get(`/requests/${r.id}`)).body);
    expect(byReceiver.lines[0]!.unitCost).toBeNull();
    expect(byReceiver.totalCost).toBeNull();
    // Nhân viên kho lập được đề nghị nên thấy giá.
    expect(PurchaseRequest.parse((await pur(A.requester).get(`/requests/${r.id}`)).body).totalCost).toBe(10000);
    expect((await pur(B.ceo).get(`/requests/${r.id}`)).status).toBe(404);
  });
});

describe('gửi duyệt và duyệt', () => {
  it('gửi duyệt khi còn dòng giá 0: 422 theo dòng; gửi được thì có sự kiện request_submitted', async () => {
    const r = await createRequest(A.requester, A.supplierId, [
      { variantId: A.v1, quantity: 1, unitCost: 1000 },
      { variantId: A.v2, quantity: 1, unitCost: 0 },
    ]);
    const zero = await act(A.requester, r.id, 'submit', { version: r.version });
    expect(zero.status).toBe(422);
    expect(zero.body.errors).toEqual({ 'lines.1.unitCost': 'Nhập giá nhập' });

    const fixed = await pur(A.requester).put(`/requests/${r.id}`, {
      supplierId: A.supplierId,
      lines: [
        { variantId: A.v1, quantity: 1, unitCost: 1000 },
        { variantId: A.v2, quantity: 1, unitCost: 3000 },
      ],
      version: r.version,
    });
    const ok = await act(A.requester, r.id, 'submit', { version: fixed.body.version });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('pending_approval');
    const events = await testPool().query(
      "select payload from core.outbox_messages where type = 'purchasing.request_submitted' and key = $1",
      [r.id],
    );
    expect(events.rows).toEqual([{ payload: { requestId: r.id, number: r.number } }]);
  });

  it('NCC ngừng giao dịch sau khi lập: gửi duyệt trả 422 supplier_inactive', async () => {
    const s = await createSupplier(A.ceo);
    const r = await createRequest(A.requester, s.id, [{ variantId: A.v1, quantity: 1, unitCost: 1000 }]);
    await pur(A.ceo).put(`/suppliers/${s.id}`, { name: s.name, active: false, version: 1 });
    const res = await act(A.requester, r.id, 'submit', { version: r.version });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('supplier_inactive');
  });

  it('người lập có quyền duyệt (không phải CEO) tự duyệt: 409 second_person_required', async () => {
    const role = await createCustomRole(A.companyId, ['purchasing.request.manage', 'purchasing.request.approve']);
    const lead = (await addMember(A.companyId, role)).token;
    const r = await createRequest(lead, A.supplierId, [{ variantId: A.v1, quantity: 1, unitCost: 1000 }]);
    const submitted = await act(lead, r.id, 'submit', { version: r.version });
    const res = await act(lead, r.id, 'approve', { version: submitted.body.version });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('second_person_required');
  });

  it('CEO duyệt đề nghị do chính mình lập: 200, đánh dấu tự duyệt', async () => {
    const r = await createRequest(A.ceo, A.supplierId, [{ variantId: A.v1, quantity: 1, unitCost: 1000 }]);
    const body = await runActions([[A.ceo, 'submit'], [A.ceo, 'approve']], r.id, r.version);
    expect(body.status).toBe('approved');
    const row = await testPool().query('select self_approved, approved_by is not null as approved from product.purchase_requests where id = $1', [r.id]);
    expect(row.rows[0]).toEqual({ self_approved: true, approved: true });
  });

  it('loại dòng cuối cùng còn lại: 409 all_lines_excluded; loại một dòng thì tổng bỏ dòng đó', async () => {
    const r = await createRequest(A.requester, A.supplierId, [
      { variantId: A.v1, quantity: 2, unitCost: 1000 },
      { variantId: A.v2, quantity: 3, unitCost: 1000 },
    ]);
    const submitted = await act(A.requester, r.id, 'submit', { version: r.version });
    const [l1, l2] = submitted.body.lines;
    const one = await pur(A.ceo).post(`/requests/${r.id}/lines/${l1.id}/exclude`, { excluded: true, reason: 'NCC hết mẫu', version: submitted.body.version });
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ lineCount: 1, totalQty: 3 });
    const last = await pur(A.ceo).post(`/requests/${r.id}/lines/${l2.id}/exclude`, { excluded: true, reason: 'NCC hết mẫu', version: one.body.version });
    expect(last.status).toBe(409);
    expect(last.body.code).toBe('all_lines_excluded');
  });

  it('duyệt sinh sản phẩm và SKU theo quy tắc danh mục cho dòng sản phẩm mới', async () => {
    const name = newName();
    const r = await createRequest(A.requester, A.supplierId, [{ newProduct: { name, categoryId: A.categoryId }, quantity: 5, unitCost: 90000 }]);
    const body = await runActions([[A.requester, 'submit'], [A.ceo, 'approve']], r.id, r.version);
    const line = body.lines[0]!;
    expect(line.variantId).not.toBeNull();
    expect(line.sku).toMatch(/^TEST-\d{4}$/);
    const product = await testPool().query(
      'select p.name, p.description from product.products p join product.product_variants v on v.product_id = p.id where v.id = $1',
      [line.variantId],
    );
    expect(product.rows[0]).toEqual({ name, description: `Tạo từ đề nghị nhập ${r.number}` });
  });

  it('tên sản phẩm mới bị dùng trước lúc duyệt: 422 và không đổi trạng thái', async () => {
    const name = newName();
    const r = await createRequest(A.requester, A.supplierId, [{ newProduct: { name, categoryId: A.categoryId }, quantity: 1, unitCost: 1000 }]);
    const submitted = await act(A.requester, r.id, 'submit', { version: r.version });
    await testPool().query('insert into product.products (company_id, category_id, name) values ($1, $2, $3)', [A.companyId, A.categoryId, name]);
    const res = await act(A.ceo, r.id, 'approve', { version: submitted.body.version });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual({ 'lines.0.newProduct.name': 'Đã có sản phẩm cùng tên' });
    expect((await pur(A.ceo).get(`/requests/${r.id}`)).body.status).toBe('pending_approval');
  });

  it('hai người cùng duyệt một đề nghị: một người 200, người kia 409 version_conflict', async () => {
    const role = await createCustomRole(A.companyId, ['purchasing.request.approve']);
    const other = (await addMember(A.companyId, role)).token;
    const r = await createRequest(A.requester, A.supplierId, [{ variantId: A.v1, quantity: 1, unitCost: 1000 }]);
    const submitted = await act(A.requester, r.id, 'submit', { version: r.version });
    const v = submitted.body.version;
    const results = await raceBehindLock(
      (holder) => holder.query('select 1 from product.purchase_requests where id = $1 for update', [r.id]),
      2,
      () => Promise.all([act(A.ceo, r.id, 'approve', { version: v }), act(other, r.id, 'approve', { version: v })]),
    );
    expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(results.find((x) => x.status === 409)!.body.code).toBe('version_conflict');
  });

  it('thao tác không có trong bảng: 404; thao tác sai trạng thái: 409 invalid_transition kèm current', async () => {
    const r = await createRequest(A.requester, A.supplierId, [{ variantId: A.v1, quantity: 1, unitCost: 1000 }]);
    expect((await act(A.requester, r.id, 'receive_all', { version: r.version })).status).toBe(404);
    const res = await act(A.requester, r.id, 'order', { version: r.version });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('invalid_transition');
    expect(res.body.current).toMatchObject({ id: r.id, status: 'draft' });
  });
});

describe('thêm dòng từ gợi ý nhập lại', () => {
  it('không có requestId thì lập nháp mới (201); thêm lại cùng SKU thì cộng dồn (200)', async () => {
    const created = await pur(A.requester).post('/requests/add-line', { requestId: null, supplierId: A.supplierId, variantId: A.v1, quantity: 4 });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'draft', note: 'Lập từ gợi ý nhập lại', totalQty: 4 });
    const again = await pur(A.requester).post('/requests/add-line', { requestId: created.body.id, supplierId: null, variantId: A.v1, quantity: 3 });
    expect(again.status).toBe(200);
    expect(again.body.lines).toEqual([expect.objectContaining({ variantId: A.v1, quantity: 7 })]);
  });

  it('đề nghị không còn là nháp: 422 errors.requestId', async () => {
    const r = await createRequest(A.requester, A.supplierId, [{ variantId: A.v1, quantity: 1, unitCost: 1000 }]);
    await act(A.requester, r.id, 'submit', { version: r.version });
    const res = await pur(A.requester).post('/requests/add-line', { requestId: r.id, supplierId: null, variantId: A.v2, quantity: 1 });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual({ requestId: 'Đề nghị không còn là nháp' });
  });
});

describe('đang về', () => {
  it('đặt NCC thì incoming tăng (dòng bị loại không tính); huỷ đề nghị đã đặt thì về 0', async () => {
    const { variantId: v } = await createVariant(A.companyId);
    const { variantId: dropped } = await createVariant(A.companyId);
    const r = await createRequest(A.requester, A.supplierId, [
      { variantId: v, quantity: 6, unitCost: 1000 },
      { variantId: dropped, quantity: 9, unitCost: 1000 },
    ]);
    const submitted = await act(A.requester, r.id, 'submit', { version: r.version });
    const excluded = await pur(A.ceo).post(`/requests/${r.id}/lines/${submitted.body.lines[1].id}/exclude`, {
      excluded: true,
      reason: 'Không cần nhập',
      version: submitted.body.version,
    });
    const ordered = await runActions([[A.ceo, 'approve'], [A.requester, 'order', { expectedDeliveryDate: '2026-11-05' }]], r.id, excluded.body.version);
    expect(ordered.status).toBe('ordered');
    expect((await inv(A.ceo).get(`/stock/${v}`)).body.level.incoming).toBe(6);
    expect((await inv(A.ceo).get(`/stock/${dropped}`)).body.level.incoming).toBe(0);

    const noReason = await act(A.ceo, r.id, 'cancel', { version: ordered.version });
    expect(noReason.status).toBe(422);
    expect(noReason.body.code).toBe('reason_required');
    const cancelled = await act(A.ceo, r.id, 'cancel', { version: ordered.version, reason: 'NCC hết hàng' });
    expect(cancelled.status).toBe(200);
    expect((await inv(A.ceo).get(`/stock/${v}`)).body.level.incoming).toBe(0);
  });

  it('đề nghị đã đặt chưa nhận lần nào không đóng thiếu được (409), phải huỷ (25 §3.2, #243)', async () => {
    const { variantId: v } = await createVariant(A.companyId);
    const r = await createRequest(A.requester, A.supplierId, [{ variantId: v, quantity: 8, unitCost: 1000 }]);
    const ordered = await runActions(
      [[A.requester, 'submit'], [A.ceo, 'approve'], [A.requester, 'order', { expectedDeliveryDate: '2026-11-20' }]],
      r.id,
      r.version,
    );
    const res = await act(A.ceo, r.id, 'close_short', { version: ordered.version, reason: 'NCC ngừng sản xuất' });
    expect([res.status, res.body.code]).toEqual([409, 'invalid_transition']);
  });

  it('đóng thiếu đề nghị nhận một phần: phần còn chờ sang đóng thiếu, incoming về 0', async () => {
    const { variantId: v } = await createVariant(A.companyId);
    const r = await createRequest(A.requester, A.supplierId, [{ variantId: v, quantity: 8, unitCost: 1000 }]);
    const ordered = await runActions(
      [[A.requester, 'submit'], [A.ceo, 'approve'], [A.requester, 'order', { expectedDeliveryDate: '2026-11-20' }]],
      r.id,
      r.version,
    );
    await testPool().query("update product.purchase_requests set status = 'partially_received' where id = $1", [r.id]);
    const closed = await runActions([[A.ceo, 'close_short', { reason: 'NCC ngừng sản xuất' }]], r.id, ordered.version);
    expect(closed.status).toBe('closed_short');
    expect(closed.lines[0]).toMatchObject({ closedShort: 8, outstanding: 0 });
    expect((await inv(A.ceo).get(`/stock/${v}`)).body.level.incoming).toBe(0);
  });
});

describe('đặt NCC, loại dòng có lý do (#243)', () => {
  it('đặt NCC thiếu ngày giao dự kiến 422 errors.expectedDeliveryDate; có thì lưu cùng mã đơn NCC', async () => {
    const r = await createRequest(A.requester, A.supplierId, [{ variantId: A.v1, quantity: 2, unitCost: 1000 }]);
    const approved = await runActions([[A.requester, 'submit'], [A.ceo, 'approve']], r.id, r.version);
    const missing = await act(A.requester, r.id, 'order', { version: approved.version });
    expect([missing.status, missing.body.errors]).toEqual([422, { expectedDeliveryDate: expect.any(String) }]);
    const tooLong = await act(A.requester, r.id, 'order', { version: approved.version, expectedDeliveryDate: '2026-11-20', supplierOrderCode: 'x'.repeat(101) });
    expect(tooLong.status).toBe(422);
    const ok = await act(A.requester, r.id, 'order', { version: approved.version, expectedDeliveryDate: '2026-11-20', supplierOrderCode: ' PO-778 ' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(PurchaseRequest.parse(ok.body)).toMatchObject({ status: 'ordered', expectedDeliveryDate: '2026-11-20', supplierOrderCode: 'PO-778' });
  });

  it('loại dòng bắt buộc lý do (422 reason_required), lưu và trả excludedReason; bỏ loại thì xoá lý do', async () => {
    const r = await createRequest(A.requester, A.supplierId, [
      { variantId: A.v1, quantity: 1, unitCost: 1000 },
      { variantId: A.v2, quantity: 1, unitCost: 1000 },
    ]);
    const sent = await act(A.requester, r.id, 'submit', { version: r.version });
    const line = sent.body.lines[1].id;
    const noReason = await pur(A.ceo).post(`/requests/${r.id}/lines/${line}/exclude`, { excluded: true, version: sent.body.version });
    expect([noReason.status, noReason.body.code]).toEqual([422, 'reason_required']);
    const excluded = await pur(A.ceo).post(`/requests/${r.id}/lines/${line}/exclude`, { excluded: true, reason: 'Giá cao', version: sent.body.version });
    expect(excluded.body.lines[1]).toMatchObject({ excluded: true, excludedReason: 'Giá cao' });
    const back = await pur(A.ceo).post(`/requests/${r.id}/lines/${line}/exclude`, { excluded: false, version: excluded.body.version });
    expect(back.body.lines[1]).toMatchObject({ excluded: false, excludedReason: null });
  });
});
