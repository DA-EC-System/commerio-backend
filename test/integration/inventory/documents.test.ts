import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { reserve, issueForOrder } from '#src/modules/inventory/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../helpers/catalog.ts';
import { addMember, createCompany } from '../helpers/company.ts';
import { testPool } from '../helpers/db.ts';
import { login } from '../helpers/http.ts';
import { archiveVariant, eventsOf, inv, levelOf, movesOf, postReceipt } from './helpers.ts';

// API phiếu kho /inventory/documents (plan #16 lát 3; Documents/21 7.1, 7.2).
let A: { companyId: string; ceo: string; admin: string; kho: string; khoId: string };
let B: { companyId: string; ceo: string };

beforeAll(async () => {
  const a = await createCompany();
  const kho = await addMember(a.companyId, 'warehouse');
  A = { companyId: a.companyId, ceo: a.ceo.token, admin: (await addMember(a.companyId, 'admin')).token, kho: kho.token, khoId: kho.accountId };
  const b = await createCompany();
  B = { companyId: b.companyId, ceo: b.ceo.token };
});

const variant = async (companyId = A.companyId) => (await createVariant(companyId)).variantId;
const receiptBody = (variantId: string, quantity = 10, unitCost = 100000) => ({
  type: 'receipt',
  note: 'nhập đầu kỳ',
  lines: [{ variantId, quantity, unitCost }],
});
const issueBody = (variantId: string, quantity: number) => ({ type: 'issue', note: 'hàng hỏng', lines: [{ variantId, quantity }] });

describe('lập và ghi sổ phiếu (AC-4, AC-19, S-2)', () => {
  it('phiếu nhập nháp số PN-000001 riêng mỗi công ty, tồn chưa đổi; ghi sổ thì tồn +10 và một dòng thẻ kho', async () => {
    const c = await createCompany();
    const v = await variant(c.companyId);
    const created = await inv(c.ceo.token).post('/documents', receiptBody(v));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ number: 'PN-000001', type: 'receipt', kind: 'manual', status: 'draft', note: 'nhập đầu kỳ', lineCount: 1, totalQty: 10, version: 1 });
    expect(created.body.lines).toEqual([expect.objectContaining({ variantId: v, quantity: 10, unitCost: 100000, sku: expect.any(String) })]);
    expect(await levelOf(c.companyId, v)).toBeNull();

    const posted = await inv(c.ceo.token).post(`/documents/${created.body.id}/post`, { version: 1 });
    expect(posted.status).toBe(200);
    expect(posted.body).toMatchObject({ status: 'done', version: 2, postedBy: 'Nguyễn Văn Thử' });
    expect(await levelOf(c.companyId, v)).toMatchObject({ onHand: 10 });
    expect(await movesOf(c.companyId, v)).toEqual([expect.objectContaining({ qty_change: 10, on_hand_after: 10 })]);
    expect(await eventsOf(c.companyId, 'inventory.receipt_posted')).toEqual([
      { receiptId: created.body.id, number: 'PN-000001', kind: 'manual', lines: [{ variantId: v, quantity: 10 }] },
    ]);

    const other = await createCompany();
    const first = await inv(other.ceo.token).post('/documents', receiptBody(await variant(other.companyId)));
    expect(first.body.number).toBe('PN-000001');
    const issue = await inv(c.ceo.token).post('/documents', issueBody(v, 1));
    expect(issue.body.number).toBe('PX-000001');
  });

  it('mỗi thao tác ghi một dòng nhật ký; thao tác lỗi không để lại dòng', async () => {
    const v = await variant();
    const created = await inv(A.ceo).post('/documents', receiptBody(v));
    await inv(A.ceo).put(`/documents/${created.body.id}`, { note: 'sửa', lines: [{ variantId: v, quantity: 5, unitCost: 1000 }], version: 1 });
    await inv(A.ceo).post(`/documents/${created.body.id}/post`, { version: 1 }); // version cũ → 409, không ghi nhật ký
    await inv(A.ceo).post(`/documents/${created.body.id}/post`, { version: 2 });
    const logs = await testPool().query(
      `select action, after->>'status' as status from audit.audit_logs where entity_id = $1 order by id`,
      [created.body.id],
    );
    expect(logs.rows).toEqual([
      { action: 'create', status: 'draft' },
      { action: 'update', status: 'draft' },
      { action: 'update', status: 'done' },
    ]);
  });
});

describe('khả dụng khi ghi sổ phiếu xuất (AC-6, AC-7)', () => {
  it('xuất vượt khả dụng → 422 insufficient_stock, phiếu vẫn nháp, version không đổi', async () => {
    const v = await variant();
    await postReceipt(A.ceo, v, 8, 1000);
    await withCompany(A.companyId, () => reserve(randomUUID(), [{ variantId: v, quantity: 5 }]));
    const doc = await inv(A.kho).post('/documents', issueBody(v, 4));
    const res = await inv(A.kho).post(`/documents/${doc.body.id}/post`, { version: 1 });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ type: '/problems/insufficient_stock', errors: { 'lines.0.quantity': 'Chỉ còn 3 khả dụng' } });
    const again = await inv(A.kho).get(`/documents/${doc.body.id}`);
    expect(again.body).toMatchObject({ status: 'draft', version: 1 });
    expect(await levelOf(A.companyId, v)).toMatchObject({ onHand: 8, reserved: 5 });
  });

  it('phiếu nhiều dòng: lỗi ở đúng chỉ số dòng, dòng đọc ra giữ thứ tự lúc lập (lặp 5 lần)', async () => {
    const vs = [await variant(), await variant(), await variant()];
    for (const v of vs) await postReceipt(A.ceo, v, 3, 1000);
    for (let k = 0; k < 5; k++) {
      const doc = await inv(A.kho).post('/documents', {
        type: 'issue',
        note: 'x',
        lines: [{ variantId: vs[0], quantity: 1 }, { variantId: vs[1], quantity: 4 }, { variantId: vs[2], quantity: 1 }],
      });
      expect(doc.body.lines.map((l: { variantId: string }) => l.variantId)).toEqual(vs);
      const res = await inv(A.kho).post(`/documents/${doc.body.id}/post`, { version: 1 });
      expect(res.body.errors).toEqual({ 'lines.1.quantity': 'Chỉ còn 3 khả dụng' });
    }
  });

  it('search có % hay _ khớp đúng ký tự, không khớp mọi phiếu', async () => {
    const c = await createCompany();
    await inv(c.ceo.token).post('/documents', { type: 'issue', note: 'giảm 50% hàng lỗi', lines: [{ variantId: await variant(c.companyId), quantity: 1 }] });
    await inv(c.ceo.token).post('/documents', { type: 'issue', note: 'hỏng', lines: [{ variantId: await variant(c.companyId), quantity: 1 }] });
    expect((await inv(c.ceo.token).get('/documents?search=%25')).body.total).toBe(1);
    expect((await inv(c.ceo.token).get('/documents?search=_')).body.total).toBe(0);
  });

  it('hai phiếu xuất 3 cái ghi sổ cùng lúc khi còn 5: một 200, một 422', async () => {
    const v = await variant();
    await postReceipt(A.ceo, v, 5, 1000);
    const d1 = await inv(A.kho).post('/documents', issueBody(v, 3));
    const d2 = await inv(A.kho).post('/documents', issueBody(v, 3));
    const [r1, r2] = await Promise.all([
      inv(A.kho).post(`/documents/${d1.body.id}/post`, { version: 1 }),
      inv(A.kho).post(`/documents/${d2.body.id}/post`, { version: 1 }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 422]);
    expect(await levelOf(A.companyId, v)).toMatchObject({ onHand: 2 });
    expect(await movesOf(A.companyId, v)).toHaveLength(2);
  });
});

describe('kiểm dữ liệu (AC-8, S-9)', () => {
  it.each([
    ['phiếu không dòng', { type: 'receipt', note: '', lines: [] }, 'lines'],
    ['xuất tay thiếu lý do', { type: 'issue', note: ' ', lines: [{ variantId: randomUUID(), quantity: 1 }] }, 'note'],
    ['nhập thiếu giá', { type: 'receipt', lines: [{ variantId: randomUUID(), quantity: 1 }] }, 'lines.0.unitCost'],
    ['nhập giá âm', { type: 'receipt', lines: [{ variantId: randomUUID(), quantity: 1, unitCost: -1 }] }, 'lines.0.unitCost'],
    ['số lượng lẻ', { type: 'receipt', lines: [{ variantId: randomUUID(), quantity: 2.5, unitCost: 1 }] }, 'lines.0.quantity'],
    ['số lượng 0', { type: 'receipt', lines: [{ variantId: randomUUID(), quantity: 0, unitCost: 1 }] }, 'lines.0.quantity'],
    ['loại phiếu sai', { type: 'x', lines: [] }, 'type'],
  ])('POST %s → 422 ở %s', async (_name, body, field) => {
    const res = await inv(A.ceo).post('/documents', body);
    expect(res.status).toBe(422);
    expect(res.body.type).toBe('/problems/validation_failed');
    expect(res.body.errors).toHaveProperty([field]);
  });

  it('biến thể không có, của công ty khác, hoặc (phiếu nhập) đã ngừng bán → errors.lines.<i>.variantId', async () => {
    const mine = await variant();
    const archived = await variant();
    await archiveVariant(archived);
    const theirs = await variant(B.companyId);
    const res = await inv(A.ceo).post('/documents', {
      type: 'receipt',
      lines: [
        { variantId: 'khong-phai-uuid', quantity: 1, unitCost: 1 },
        { variantId: theirs, quantity: 1, unitCost: 1 },
        { variantId: archived, quantity: 1, unitCost: 1 },
        { variantId: mine, quantity: 1, unitCost: 1 },
      ],
    });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.errors).sort()).toEqual(['lines.0.variantId', 'lines.1.variantId', 'lines.2.variantId']);
    const dup = await inv(A.ceo).post('/documents', { type: 'receipt', lines: [{ variantId: mine, quantity: 1, unitCost: 1 }, { variantId: mine, quantity: 1, unitCost: 1 }] });
    expect(dup.body.errors).toEqual({ 'lines.1.variantId': 'Biến thể bị lặp' });
  });

  it('phiếu xuất tay nhận biến thể đã ngừng bán (xuất bỏ hàng còn lại, A7)', async () => {
    const v = await variant();
    await postReceipt(A.ceo, v, 2, 1000);
    await archiveVariant(v);
    expect((await inv(A.ceo).post('/documents', issueBody(v, 2))).status).toBe(201);
  });

  it('PUT áp cùng luật theo loại phiếu đã lưu', async () => {
    const doc = await inv(A.ceo).post('/documents', issueBody(await variant(), 1));
    const res = await inv(A.ceo).put(`/documents/${doc.body.id}`, { note: '', lines: [{ variantId: randomUUID(), quantity: 1 }], version: 1 });
    expect(res.status).toBe(422);
    expect(res.body.errors).toHaveProperty(['note']);
  });

  it.each(['?pageSize=0', '?pageSize=101', '?type=x', '?status=x', '?page=abc'])('GET /documents%s → 422', async (q) => {
    expect((await inv(A.ceo).get(`/documents${q}`)).status).toBe(422);
  });
});

describe('trạng thái và version (AC-9, AC-10)', () => {
  it('phiếu đã ghi sổ hoặc đã huỷ: PUT, post, cancel với version đúng → 409 not_draft', async () => {
    const v = await variant();
    const done = await postReceipt(A.ceo, v, 1, 1000);
    const draft = await inv(A.ceo).post('/documents', receiptBody(v));
    const cancelled = await inv(A.ceo).post(`/documents/${draft.body.id}/cancel`, { version: 1 });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');
    for (const doc of [done, cancelled.body]) {
      const body = { note: 'x', lines: [{ variantId: v, quantity: 1, unitCost: 1 }], version: doc.version };
      expect((await inv(A.ceo).put(`/documents/${doc.id}`, body)).body.type).toBe('/problems/not_draft');
      expect((await inv(A.ceo).post(`/documents/${doc.id}/post`, { version: doc.version })).status).toBe(409);
      expect((await inv(A.ceo).post(`/documents/${doc.id}/cancel`, { version: doc.version })).body.type).toBe('/problems/not_draft');
    }
    expect(await levelOf(A.companyId, v)).toMatchObject({ onHand: 1 });
  });

  it('phiếu xuất theo đơn (do issueForOrder) không sửa, không huỷ được', async () => {
    const v = await variant();
    await postReceipt(A.ceo, v, 3, 1000);
    const order = randomUUID();
    await withCompany(A.companyId, () => reserve(order, [{ variantId: v, quantity: 1 }]));
    const issue = await withCompany(A.companyId, () => issueForOrder(order));
    const doc = await inv(A.ceo).get(`/documents/${issue.issueId}`);
    expect(doc.body).toMatchObject({ kind: 'order', status: 'done' });
    const res = await inv(A.ceo).post(`/documents/${issue.issueId}/cancel`, { version: doc.body.version });
    expect(res.body.type).toBe('/problems/not_draft');
  });

  it('version cũ → 409 version_conflict kèm current là phiếu mới nhất', async () => {
    const v = await variant();
    const doc = await inv(A.ceo).post('/documents', receiptBody(v));
    await inv(A.ceo).put(`/documents/${doc.body.id}`, { note: 'lần 2', lines: [{ variantId: v, quantity: 2, unitCost: 5 }], version: 1 });
    for (const call of [
      () => inv(A.ceo).put(`/documents/${doc.body.id}`, { note: 'x', lines: [{ variantId: v, quantity: 1, unitCost: 1 }], version: 1 }),
      () => inv(A.ceo).post(`/documents/${doc.body.id}/post`, { version: 1 }),
      () => inv(A.ceo).post(`/documents/${doc.body.id}/cancel`, { version: 1 }),
    ]) {
      const res = await call();
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ type: '/problems/version_conflict', current: { id: doc.body.id, version: 2, note: 'lần 2', status: 'draft' } });
    }
  });
});

describe('quyền, giá, công ty khác (AC-13, AC-14, AC-15, S-8)', () => {
  it('Admin lập phiếu → 403 trước kiểm dữ liệu; không token → 401; chưa chọn công ty → 403 company_not_selected', async () => {
    const res = await inv(A.admin).post('/documents', {});
    expect(res.status).toBe(403);
    expect(res.body.type).toBe('/problems/forbidden');
    expect((await inv('').get('/documents')).status).toBe(401);
    const { token } = await login((await addMember(A.companyId, 'warehouse')).email);
    expect((await inv(token).get('/documents')).body.type).toBe('/problems/company_not_selected');
  });

  it('Kho thấy giá trên phiếu nhập tay, không thấy trên phiếu xuất; CEO thấy cả hai; Admin xem phiếu không thấy giá', async () => {
    const v = await variant();
    const receipt = await postReceipt(A.kho, v, 4, 120000);
    const issue = await inv(A.kho).post('/documents', issueBody(v, 1));
    await inv(A.kho).post(`/documents/${issue.body.id}/post`, { version: 1 });
    const cost = async (token: string, id: string) => (await inv(token).get(`/documents/${id}`)).body.lines[0].unitCost;
    expect(await cost(A.kho, receipt.id)).toBe(120000);
    expect(await cost(A.kho, issue.body.id)).toBeNull();
    expect(await cost(A.ceo, issue.body.id)).toBe(120000);
    expect(await cost(A.admin, receipt.id)).toBeNull();
    expect((await inv(A.kho).get(`/documents/${receipt.id}`)).body.createdBy).toBe('Nhân Viên Thử');
  });

  it('phiếu của công ty khác → 404 cho GET, PUT, post, cancel; không đổi gì; danh sách không có', async () => {
    const theirs = await inv(B.ceo).post('/documents', receiptBody(await variant(B.companyId)));
    const id = theirs.body.id;
    expect((await inv(A.ceo).get(`/documents/${id}`)).status).toBe(404);
    expect((await inv(A.ceo).put(`/documents/${id}`, { note: 'x', lines: [{ variantId: randomUUID(), quantity: 1, unitCost: 1 }], version: 1 })).status).toBe(404);
    expect((await inv(A.ceo).post(`/documents/${id}/post`, { version: 1 })).status).toBe(404);
    expect((await inv(A.ceo).post(`/documents/${id}/cancel`, { version: 1 })).status).toBe(404);
    expect((await inv(A.ceo).get('/documents/khong-phai-uuid')).status).toBe(404);
    expect((await inv(B.ceo).get(`/documents/${id}`)).body).toMatchObject({ status: 'draft', version: 1 });
    const list = await inv(A.ceo).get('/documents?pageSize=100');
    expect(list.body.items.map((d: { id: string }) => d.id)).not.toContain(id);
  });
});

describe('danh sách phiếu (S-3)', () => {
  it('mới nhất trước, lọc theo loại, trạng thái, tìm theo số hoặc ghi chú, phân trang', async () => {
    const c = await createCompany();
    const v = await variant(c.companyId);
    await postReceipt(c.ceo.token, v, 5, 1000);
    await inv(c.ceo.token).post('/documents', { type: 'issue', note: 'Kiểm kê lệch', lines: [{ variantId: v, quantity: 1 }] });
    const all = await inv(c.ceo.token).get('/documents');
    expect(all.body).toMatchObject({ total: 2, page: 1, pageSize: 20 });
    expect(all.body.items.map((d: { number: string }) => d.number)).toEqual(['PX-000001', 'PN-000001']);
    expect(all.body.items[0]).toMatchObject({ type: 'issue', kind: 'manual', status: 'draft', lineCount: 1, totalQty: 1, postedBy: null, reference: null });
    expect((await inv(c.ceo.token).get('/documents?type=receipt')).body.items).toHaveLength(1);
    expect((await inv(c.ceo.token).get('/documents?status=done')).body.items[0].number).toBe('PN-000001');
    expect((await inv(c.ceo.token).get('/documents?search=kiểm kê')).body.total).toBe(1);
    expect((await inv(c.ceo.token).get('/documents?search=pn-0')).body.total).toBe(1);
    const page2 = await inv(c.ceo.token).get('/documents?page=2&pageSize=1');
    expect(page2.body).toMatchObject({ total: 2, page: 2, pageSize: 1 });
    expect(page2.body.items[0].number).toBe('PN-000001');
  });
});
