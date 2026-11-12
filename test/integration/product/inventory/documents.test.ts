import { beforeAll, describe, expect, it } from 'vitest';
import { StockDoc } from '#src/modules/product/inventory/api/schemas.ts';
import { receiveBack } from '#src/modules/product/inventory/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany, createCustomRole } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { inv, receive, setBuckets } from './helpers.ts';

// Phiếu kho có duyệt (#208; Documents/21 mục 15.2–15.4; ca B3a, B3b ở Documents/kiem-thu/ca-theo-so-do.md; US-TK-06…10).

let companyId: string;
let ceo: string;
let kho: string;
let khoId: string;
let admin: string;
let sale: string;
let lapDuyet: string;
let v1: string;
let v2: string;

beforeAll(async () => {
  const c = await createCompany();
  companyId = c.companyId;
  ceo = c.ceo.token;
  const khoMember = await addMember(companyId, 'warehouse');
  kho = khoMember.token;
  khoId = khoMember.accountId;
  admin = (await addMember(companyId, 'admin')).token;
  sale = (await addMember(companyId, 'sale')).token;
  // Vai trò tuỳ biến vừa lập vừa duyệt phiếu kho: ca người thứ hai không phải CEO
  const role = await createCustomRole(companyId, ['inventory.stock.view', 'inventory.receipt.create', 'inventory.document.approve']);
  lapDuyet = (await addMember(companyId, role)).token;
  v1 = (await createVariant(companyId)).variantId;
  v2 = (await createVariant(companyId)).variantId;
  await receive(companyId, v1, 50, 60000);
  await receive(companyId, v2, 20, 30000);
});

const level = async (variantId: string) => (await inv(ceo).get(`/stock/${variantId}`)).body.level;

async function draft(token: string, body: object) {
  const res = await inv(token).post('/documents', body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return StockDoc.parse(res.body);
}
const act = (token: string, id: string, action: string, body: object) => inv(token).post(`/documents/${id}/${action}`, body);

describe('B3a kiểm kê, xuất huỷ, chuyển chờ xử lý', () => {
  it('B3a-01..02: kiểm kê thấy thiếu 2 áo → chờ duyệt tạm khoá 2, khả dụng giảm 2 → CEO duyệt: tồn thực giảm 2, thẻ kho một dòng', async () => {
    const before = await level(v1);
    const doc = await draft(kho, { type: 'stocktake', area: 'stock', note: 'Kiểm cuối tuần', lines: [{ variantId: v1, counted: before.onHand - 2 }] });
    expect(doc.lines[0]).toMatchObject({ bookQty: before.onHand, counted: before.onHand - 2, quantity: -2 });
    const sent = await act(kho, doc.id, 'submit', { version: doc.version });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(StockDoc.parse(sent.body)).toMatchObject({ status: 'pending', lines: [{ locked: 2 }] });
    expect(await level(v1)).toMatchObject({ locked: 2, available: before.available - 2 });
    const ok = await act(ceo, doc.id, 'approve', { version: sent.body.version });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'posted', postedBy: expect.any(String) });
    const after = await level(v1);
    expect(after).toMatchObject({ onHand: before.onHand - 2, locked: 0 });
    const moves = (await inv(ceo).get(`/stock/${v1}`)).body.moves.filter((m: { document: { id: string } }) => m.document.id === doc.id);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ qtyChange: -2 });
    expect(ok.body.lines[0].unitCost).toBe(60000);
  });

  it('B3a-03: CEO từ chối (bắt buộc lý do) thì hết tạm khoá, tồn không đổi', async () => {
    const before = await level(v1);
    const doc = await draft(kho, { type: 'write_off', area: 'stock', note: 'Rách', lines: [{ variantId: v1, quantity: 3 }] });
    const events = async () =>
      (await testPool().query("select payload from core.outbox_messages where type = 'inventory.stock_changed' and key = $1 order by id", [v1])).rows;
    const n = (await events()).length;
    const sent = (await act(kho, doc.id, 'submit', { version: doc.version })).body;
    expect((await level(v1)).locked).toBe(3);
    // Gửi duyệt giữ lại 3: phát stock_changed với số có thể bán đã giảm (US-TK-06, 21 §11.1)
    const held = await events();
    expect(held).toHaveLength(n + 1);
    expect(held.at(-1).payload).toEqual({ variantId: v1, onHand: before.onHand, reserved: before.reserved, available: before.available - 3 });
    const noReason = await act(ceo, doc.id, 'reject', { version: sent.version });
    expect([noReason.status, noReason.body.code]).toEqual([422, 'reason_required']);
    const rejected = await act(ceo, doc.id, 'reject', { version: sent.version, reason: 'Hàng còn dùng được' });
    expect(rejected.body).toMatchObject({ status: 'rejected', needsDecision: false });
    expect(await level(v1)).toMatchObject({ onHand: before.onHand, locked: 0 });
    // Từ chối nhả phần giữ: phát stock_changed với số có thể bán tăng lại (US-TK-09)
    const freed = await events();
    expect(freed).toHaveLength(n + 2);
    expect(freed.at(-1).payload).toEqual({ variantId: v1, onHand: before.onHand, reserved: before.reserved, available: before.available });
  });

  it('B3a-01g, B3a-04: gửi duyệt phiếu không dòng 409 empty_document; huỷ nháp', async () => {
    const doc = await draft(kho, { type: 'to_quarantine', note: 'Lỗi', lines: [{ variantId: v2, quantity: 1 }] });
    await testPool().query('delete from product.stock_document_lines where document_id = $1', [doc.id]);
    const empty = await act(kho, doc.id, 'submit', { version: doc.version });
    expect([empty.status, empty.body.code]).toEqual([409, 'empty_document']);
    const cancelled = await act(kho, doc.id, 'cancel', { version: doc.version });
    expect(cancelled.body.status).toBe('cancelled');
    for (const action of ['submit', 'approve', 'reject', 'cancel']) {
      const res = await act(ceo, doc.id, action, { version: cancelled.body.version, reason: 'x' });
      expect([action, res.status, res.body.code]).toEqual([action, 409, 'invalid_transition']);
    }
  });

  it('gửi duyệt phiếu giảm vượt khả dụng: 422 stock_insufficient theo dòng', async () => {
    const doc = await draft(kho, { type: 'write_off', area: 'stock', note: 'Mất', lines: [{ variantId: v2, quantity: 9999 }] });
    const res = await act(kho, doc.id, 'submit', { version: doc.version });
    expect([res.status, res.body.code]).toEqual([422, 'stock_insufficient']);
    expect(res.body.errors).toHaveProperty(['lines.0.quantity']);
  });

  it('B3a-01q, B3a-02q, B3a-03q: Admin, Sale không lập, không gửi; Kho không duyệt, không từ chối', async () => {
    for (const token of [admin, sale]) {
      const res = await inv(token).post('/documents', { type: 'stocktake', note: '', lines: [{ variantId: v1, counted: 1 }] });
      expect([res.status, res.body.code]).toEqual([403, 'forbidden']);
    }
    const doc = await draft(kho, { type: 'to_quarantine', note: 'Lỗi chỉ', lines: [{ variantId: v2, quantity: 1 }] });
    for (const token of [admin, sale]) {
      expect((await act(token, doc.id, 'submit', { version: doc.version })).status).toBe(403);
    }
    const sent = (await act(kho, doc.id, 'submit', { version: doc.version })).body;
    for (const action of ['approve', 'reject']) {
      const res = await act(kho, doc.id, action, { version: sent.version, reason: 'x' });
      expect([action, res.status, res.body.code]).toEqual([action, 403, 'forbidden']);
    }
  });

  it('B3a-02p, B3a-02s: người lập có quyền duyệt (không phải CEO) không tự duyệt được; CEO tự lập tự duyệt, có nhãn tự duyệt', async () => {
    const own = await draft(lapDuyet, { type: 'to_quarantine', note: 'Lỗi', lines: [{ variantId: v2, quantity: 1 }] });
    const sent = (await act(lapDuyet, own.id, 'submit', { version: own.version })).body;
    const self = await act(lapDuyet, own.id, 'approve', { version: sent.version });
    expect([self.status, self.body.code]).toEqual([409, 'second_person_required']);

    const mine = await draft(ceo, { type: 'to_quarantine', note: 'Lỗi', lines: [{ variantId: v2, quantity: 1 }] });
    const pending = (await act(ceo, mine.id, 'submit', { version: mine.version })).body;
    const before = await level(v2);
    const ok = await act(ceo, mine.id, 'approve', { version: pending.version });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.statusHistory.at(-1)).toMatchObject({ to: 'posted', selfApproved: true });
    expect(await level(v2)).toMatchObject({ onHand: before.onHand - 1, quarantine: before.quarantine + 1 });
  });

  it('xuất huỷ hàng chờ xử lý bị từ chối: phải chọn nhập lại tồn hoặc trả NCC; chọn lần hai 409 decision_made', async () => {
    await setBuckets(companyId, v2, { quarantine: 5 });
    const before = await level(v2);
    const doc = await draft(kho, { type: 'write_off', area: 'quarantine', note: 'Hỏng nặng', lines: [{ variantId: v2, quantity: 2 }] });
    const sent = (await act(kho, doc.id, 'submit', { version: doc.version })).body;
    // Xuất huỷ từ chờ xử lý không khoá tồn thực
    expect((await level(v2)).locked).toBe(before.locked);
    const rejected = (await act(ceo, doc.id, 'reject', { version: sent.version, reason: 'Sửa được' })).body;
    expect(rejected).toMatchObject({ needsDecision: true, rejectDecision: null });
    const restock = await inv(kho).post(`/documents/${doc.id}/decide`, { decision: 'restock', version: rejected.version });
    expect(restock.status, JSON.stringify(restock.body)).toBe(200);
    expect(restock.body).toMatchObject({ needsDecision: false, rejectDecision: 'restock' });
    expect(await level(v2)).toMatchObject({ onHand: before.onHand + 2, quarantine: before.quarantine - 2 });
    const again = await inv(kho).post(`/documents/${doc.id}/decide`, { decision: 'supplier_return', version: restock.body.version });
    expect([again.status, again.body.code]).toEqual([409, 'decision_made']);

    const other = await draft(kho, { type: 'write_off', area: 'quarantine', note: 'Lỗi NCC', lines: [{ variantId: v2, quantity: 1 }] });
    const p2 = (await act(kho, other.id, 'submit', { version: other.version })).body;
    const r2 = (await act(ceo, other.id, 'reject', { version: p2.version, reason: 'Trả NCC' })).body;
    const sr = await inv(kho).post(`/documents/${other.id}/decide`, { decision: 'supplier_return', version: r2.version });
    expect(sr.body.followUps).toEqual([expect.objectContaining({ type: 'supplier_return', number: expect.stringMatching(/^TN-/) })]);
  });

  it('kiểm kê CEO duyệt được làm tồn âm khi đang giữ nhiều hơn tồn đếm được (25 §7.1), bật cờ Tồn âm', async () => {
    const v = (await createVariant(companyId)).variantId;
    await receive(companyId, v, 5, 10000);
    await setBuckets(companyId, v, { reserved: 4 });
    const doc = await draft(kho, { type: 'stocktake', area: 'stock', note: '', lines: [{ variantId: v, counted: 1 }] });
    const sent = (await act(kho, doc.id, 'submit', { version: doc.version })).body;
    const ok = await act(ceo, doc.id, 'approve', { version: sent.version });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await level(v)).toMatchObject({ onHand: 1, reserved: 4, negative: true });
    const event = await testPool().query(
      "select payload from core.outbox_messages where type = 'inventory.stocktake_posted' and key = $1",
      [doc.id],
    );
    expect(event.rows[0].payload).toMatchObject({ documentId: doc.id, source: null, lines: [{ variantId: v, countedQty: 1, delta: -4 }] });
  });

  it('danh sách lọc theo loại, trạng thái, số phiếu; công ty khác 404', async () => {
    const res = await inv(ceo).get('/documents?type=stocktake&status=posted');
    expect(res.status).toBe(200);
    expect(res.body.items.every((d: { type: string; status: string }) => d.type === 'stocktake' && d.status === 'posted')).toBe(true);
    const other = await createCompany();
    const doc = res.body.items[0];
    expect((await inv(other.ceo.token).get(`/documents/${doc.id}`)).status).toBe(404);
  });
});

describe('B3b kiểm hàng về', () => {
  /** Hàng về với số dự kiến `quantity`; `scanned` mặc định 0 (kho quét sau trên phiếu nháp bằng PUT). */
  async function inspection(source: 'package' | 'return_request', lines: { variantId: string; quantity: number; scanned?: number }[], meta = {}) {
    const merged = lines.map((l) => ({ variantId: l.variantId, expected: l.quantity, scanned: l.scanned ?? 0 }));
    const { documentId } = await withCompany(companyId, () => receiveBack({ type: source, id: crypto.randomUUID() }, merged, meta));
    return StockDoc.parse((await inv(kho).get(`/documents/${documentId}`)).body);
  }

  it('B3b-01, B3b-01g: không thiếu thì ghi sổ thẳng; bán lại vào tồn, hỏng sinh xuất huỷ nháp, trả NCC sinh phiếu trả NCC nháp', async () => {
    const doc = await inspection('package', [{ variantId: v1, quantity: 3 }], { number: 'KIEN-001' });
    expect(doc).toMatchObject({ type: 'return_inspection', kind: 'auto', status: 'draft', source: { type: 'package', number: 'KIEN-001' } });
    const early = await act(kho, doc.id, 'post', { version: doc.version });
    expect([early.status, early.body.code]).toEqual([409, 'shortage_needs_review']);
    const before = await level(v1);
    const scanned = (
      await inv(kho).put(`/documents/${doc.id}`, {
        note: doc.note,
        lines: [{ variantId: v1, scanned: 3, resell: 1, damaged: 1, toSupplier: 1 }],
        version: doc.version,
      })
    ).body;
    expect(scanned.lines[0]).toMatchObject({ expected: 3, quantity: 3, resell: 1, damaged: 1, toSupplier: 1 });
    const posted = await act(kho, doc.id, 'post', { version: scanned.version });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect(await level(v1)).toMatchObject({ onHand: before.onHand + 1, quarantine: before.quarantine + 2 });
    expect(posted.body.followUps.map((f: { type: string }) => f.type).sort()).toEqual(['stock_document', 'supplier_return']);
    const writeOff = posted.body.followUps.find((f: { type: string }) => f.type === 'stock_document');
    expect((await inv(kho).get(`/documents/${writeOff.id}`)).body).toMatchObject({ type: 'write_off', area: 'quarantine', status: 'draft' });
    const event = await testPool().query("select 1 from core.outbox_messages where type = 'inventory.return_inspected' and key = $1", [doc.id]);
    expect(event.rowCount).toBe(0);
  });

  it('B3b-02..04: có thiếu thì gửi duyệt bật cờ khiếu nại; người quét không tự duyệt; người khác yêu cầu kiểm lại rồi duyệt', async () => {
    const orderId = crypto.randomUUID();
    const shopId = crypto.randomUUID();
    const doc = await inspection('return_request', [{ variantId: v2, quantity: 2 }], {
      number: 'TR-0001',
      orderId,
      shopId,
      unitCosts: { [v2]: '30000.00' },
    });
    const noShort = (
      await inv(kho).put(`/documents/${doc.id}`, { note: '', lines: [{ variantId: v2, scanned: 2, resell: 2 }], version: doc.version })
    ).body;
    const nothing = await act(kho, doc.id, 'submit', { version: noShort.version });
    expect([nothing.status, nothing.body.code]).toEqual([409, 'no_shortage']);
    const short = (
      await inv(kho).put(`/documents/${doc.id}`, { note: '', lines: [{ variantId: v2, scanned: 1, resell: 1 }], version: noShort.version })
    ).body;
    const sent = await act(kho, doc.id, 'submit', { version: short.version });
    expect(sent.body).toMatchObject({ status: 'pending', claimFlag: true });
    const self = await act(kho, doc.id, 'approve', { version: sent.body.version });
    expect([self.status, self.body.code]).toEqual([409, 'second_person_required']);
    const back = await act(lapDuyet, doc.id, 'reject', { version: sent.body.version, reason: 'Đếm lại thùng 2' });
    expect(back.body.status).toBe('draft');
    const again = await act(kho, doc.id, 'submit', { version: back.body.version });
    const ok = await act(lapDuyet, doc.id, 'approve', { version: again.body.version });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('posted');
    const event = await testPool().query("select payload from core.outbox_messages where type = 'inventory.return_inspected' and key = $1", [doc.id]);
    expect(event.rows).toHaveLength(1);
    expect(event.rows[0].payload).toEqual({
      inspectionId: doc.id,
      orderId,
      shopId,
      inspectedAt: expect.any(String),
      lines: [{ variantId: v2, resellable: 1, unitCost: '30000.00' }],
    });
  });

  it('kiện hoàn gọi receiveBack không meta: phiếu không có đơn, gian hàng; ghi sổ không phát return_inspected', async () => {
    const { documentId } = await withCompany(companyId, () => receiveBack({ type: 'package', id: crypto.randomUUID() }, [{ variantId: v1, expected: 1, scanned: 1 }]));
    const doc = StockDoc.parse((await inv(kho).get(`/documents/${documentId}`)).body);
    expect(doc).toMatchObject({ type: 'return_inspection', status: 'draft', number: expect.stringMatching(/^KT-/) });
    const scanned = (
      await inv(kho).put(`/documents/${doc.id}`, { note: '', lines: [{ variantId: v1, scanned: 1, resell: 1 }], version: doc.version })
    ).body;
    const posted = await act(kho, doc.id, 'post', { version: scanned.version });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    const { rows } = await testPool().query('select order_id, shop_id, source_number from product.stock_documents where id = $1', [doc.id]);
    expect(rows[0]).toEqual({ order_id: null, shop_id: null, source_number: null });
    const event = await testPool().query("select 1 from core.outbox_messages where type = 'inventory.return_inspected' and key = $1", [doc.id]);
    expect(event.rowCount).toBe(0);
  });

  it('yêu cầu trả của đơn không gắn gian hàng: ghi sổ tồn bình thường, không phát return_inspected (21 §11.2, #308)', async () => {
    const doc = await inspection('return_request', [{ variantId: v1, quantity: 1 }], { number: 'TR-0002', orderId: crypto.randomUUID(), shopId: null });
    const scanned = (
      await inv(kho).put(`/documents/${doc.id}`, { note: '', lines: [{ variantId: v1, scanned: 1, resell: 1 }], version: doc.version })
    ).body;
    const posted = await act(kho, doc.id, 'post', { version: scanned.version });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    const event = await testPool().query("select 1 from core.outbox_messages where type = 'inventory.return_inspected' and key = $1", [doc.id]);
    expect(event.rowCount).toBe(0);
  });

  it('sai mẫu: nhận SKU khác ghi theo SKU thực nhận (dòng dự kiến 0)', async () => {
    const doc = await inspection('package', [{ variantId: v1, quantity: 1 }]);
    const res = await inv(kho).put(`/documents/${doc.id}`, {
      note: '',
      lines: [
        { variantId: v1, scanned: 0 },
        { variantId: v2, scanned: 1, resell: 1 },
      ],
      version: doc.version,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.lines.map((l: { variantId: string; expected: number; quantity: number }) => [l.variantId, l.expected, l.quantity])).toEqual([
      [v1, 1, 0],
      [v2, 0, 1],
    ]);
  });

  it('gọi lại cùng nguồn trả phiếu cũ, không lập phiếu thứ hai (Documents/21 §11.1)', async () => {
    const source = { type: 'package' as const, id: crypto.randomUUID() };
    const first = await withCompany(companyId, () => receiveBack(source, [{ variantId: v1, expected: 1, scanned: 1 }]));
    const again = await withCompany(companyId, () => receiveBack(source, [{ variantId: v1, expected: 1, scanned: 1 }]));
    expect(again).toEqual(first);
    const other = await withCompany(companyId, () => receiveBack({ ...source, type: 'return_request' }, [{ variantId: v1, expected: 1, scanned: 1 }]));
    expect(other.documentId).not.toBe(first.documentId);
  });

  it('US-TK-10: nhận thì chờ xử lý tăng đúng số quét; sửa số quét trên phiếu nháp đổi đúng phần chênh; ghi sổ chuyển phần bán lại sang tồn thực theo giá vốn dòng kiện, hỏng và trả NCC ở lại', async () => {
    const v = (await createVariant(companyId)).variantId;
    await receive(companyId, v, 10, 60000);
    const start = await level(v);
    // Dòng kiện có giá vốn 30.000 khác bình quân hiện tại 60.000
    const doc = await inspection('return_request', [{ variantId: v, quantity: 5, scanned: 5 }], {
      number: 'TR-0100',
      orderId: crypto.randomUUID(),
      unitCosts: { [v]: '30000.00' },
    });
    expect(doc.lines[0]).toMatchObject({ expected: 5, quantity: 5 });
    expect(await level(v)).toMatchObject({ onHand: start.onHand, quarantine: start.quarantine + 5 });

    // Đếm lại chỉ có 4: chờ xử lý giảm đúng 1
    const fixed = await inv(kho).put(`/documents/${doc.id}`, {
      note: '',
      lines: [{ variantId: v, scanned: 4, resell: 2, damaged: 1, toSupplier: 1 }],
      version: doc.version,
    });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    expect(await level(v)).toMatchObject({ onHand: start.onHand, quarantine: start.quarantine + 4 });
    const sent = await act(kho, doc.id, 'submit', { version: fixed.body.version });
    const ok = await act(lapDuyet, doc.id, 'approve', { version: sent.body.version });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // Bán lại 2 rời chờ xử lý sang tồn thực; hỏng 1, trả NCC 1 ở lại, không cộng lần hai
    const after = await level(v);
    expect(after).toMatchObject({ onHand: start.onHand + 2, quarantine: start.quarantine + 2 });
    // Bình quân gia quyền: (10 × 60.000 + 2 × 30.000) / 12 = 55.000
    expect(after.avgCost).toBe(55000);
  });

  it('người quét (meta.actorId) là người mà bước duyệt phần thiếu phải khác: người quét tự duyệt thì 409 second_person_required, kể cả khi người khác gửi duyệt', async () => {
    const { documentId } = await withCompany(companyId, () =>
      receiveBack({ type: 'package', id: crypto.randomUUID() }, [{ variantId: v2, expected: 2, scanned: 1 }], { actorId: khoId }),
    );
    const doc = StockDoc.parse((await inv(kho).get(`/documents/${documentId}`)).body);
    const split = await inv(lapDuyet).put(`/documents/${doc.id}`, { note: '', lines: [{ variantId: v2, scanned: 1, resell: 1 }], version: doc.version });
    const sent = await act(lapDuyet, doc.id, 'submit', { version: split.body.version });
    expect(sent.body.status).toBe('pending');
    const self = await act(kho, doc.id, 'approve', { version: sent.body.version });
    expect([self.status, self.body.code]).toEqual([409, 'second_person_required']);
    const ok = await act(lapDuyet, doc.id, 'approve', { version: sent.body.version });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const moves = await testPool().query('select done_by from product.stock_moves where source_id = $1 order by id limit 1', [doc.id]);
    expect(moves.rows[0].done_by).toBe(khoId);
  });

  it('chưa chia đủ số quét (bán lại + hỏng + trả NCC khác số quét) thì không ghi sổ được: 422 theo dòng', async () => {
    const doc = await inspection('package', [{ variantId: v1, quantity: 2, scanned: 2 }]);
    const res = await act(kho, doc.id, 'post', { version: doc.version });
    expect([res.status, res.body.code, Object.keys(res.body.errors)]).toEqual([422, 'validation_failed', ['lines.0.resell']]);
  });
});
