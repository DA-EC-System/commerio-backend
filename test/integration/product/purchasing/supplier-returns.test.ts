import { beforeAll, describe, expect, it } from 'vitest';
import { SupplierReturn } from '#src/modules/product/purchasing/api/schemas.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany, createCustomRole } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { inv, receive, setBuckets } from '../inventory/helpers.ts';
import { createSupplier, pur } from './helpers.ts';

// Phiếu trả NCC (#210; sơ đồ B4, Documents/21 mục 16.2–16.4; US-NH-12…NH-15). Mã ca theo Documents/kiem-thu/ca-theo-so-do.md.

let companyId: string;
let ceo: string;
let kho: string;
let admin: string;
let sale: string;
let guiVaGhi: string;
let supplierId: string;
let variantId: string;

beforeAll(async () => {
  const c = await createCompany();
  companyId = c.companyId;
  ceo = c.ceo.token;
  kho = (await addMember(companyId, 'warehouse')).token;
  admin = (await addMember(companyId, 'admin')).token;
  sale = (await addMember(companyId, 'sale')).token;
  // Vừa duyệt gửi vừa ghi kết quả, không phải CEO: ca người thứ hai
  const role = await createCustomRole(companyId, ['purchasing.return.manage', 'purchasing.request.approve', 'purchasing.request.manage']);
  guiVaGhi = (await addMember(companyId, role)).token;
  supplierId = (await createSupplier(ceo)).id;
  variantId = (await createVariant(companyId)).variantId;
  await receive(companyId, variantId, 10, 40000);
  await setBuckets(companyId, variantId, { quarantine: 100 });
});

const act = (token: string, id: string, action: string, body: object) => pur(token).post(`/supplier-returns/${id}/${action}`, body);
const quarantine = async () => (await inv(ceo).get(`/stock/${variantId}`)).body.level.quarantine as number;

async function draft(token = kho, quantity = 2, withSupplier = true) {
  const res = await pur(token).post('/supplier-returns', { supplierId: withSupplier ? supplierId : null, note: 'Hàng lỗi', lines: [{ variantId, quantity }] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return SupplierReturn.parse(res.body);
}

async function sent(sender = ceo) {
  const d = await draft();
  const p = (await act(kho, d.id, 'submit', { version: d.version })).body;
  const s = await act(sender, d.id, 'approve_send', { version: p.version });
  expect(s.status, JSON.stringify(s.body)).toBe(200);
  return SupplierReturn.parse(s.body);
}

describe('B4 phiếu trả NCC', () => {
  it('lập tay cho hàng chờ xử lý: không vượt chờ xử lý (422 theo dòng)', async () => {
    const res = await pur(kho).post('/supplier-returns', { supplierId, note: '', lines: [{ variantId, quantity: 100000 }] });
    expect([res.status, res.body.code]).toEqual([422, 'validation_failed']);
    expect(res.body.errors).toHaveProperty(['lines.0.quantity']);
  });

  it('B4-01, B4-01g: gửi duyệt cần có dòng và NCC', async () => {
    const noSupplier = await draft(kho, 1, false);
    const r = await act(kho, noSupplier.id, 'submit', { version: noSupplier.version });
    expect([r.status, r.body.code]).toEqual([409, 'supplier_required']);
    const ok = await draft();
    const res = await act(kho, ok.id, 'submit', { version: ok.version });
    expect(res.body.status).toBe('pending_approval');
  });

  it('B4-03: CEO duyệt và gửi thì chờ xử lý giảm; B4-04 Kho ghi NCC hoàn tiền, phát sự kiện', async () => {
    const before = await quarantine();
    const s = await sent();
    expect(s).toMatchObject({ status: 'sent', sentById: expect.any(String) });
    expect(await quarantine()).toBe(before - 2);
    const noMoney = await act(kho, s.id, 'record_refund', { version: s.version });
    expect([noMoney.status, noMoney.body.code]).toEqual([422, 'refund_required']);
    const refunded = await act(kho, s.id, 'record_refund', { version: s.version, refundAmount: 80000 });
    expect(refunded.status, JSON.stringify(refunded.body)).toBe(200);
    expect(refunded.body).toMatchObject({ status: 'refunded', refundAmount: 80000 });
    const event = await testPool().query(
      "select payload from core.outbox_messages where type = 'purchasing.supplier_return_refunded' and key = $1",
      [s.id],
    );
    expect(event.rows[0].payload).toMatchObject({ supplierReturnId: s.id, supplierId, refundAmount: '80000.00' });
  });

  it('B4-06: NCC không nhận thì hàng về lại chờ xử lý', async () => {
    const s = await sent();
    const before = await quarantine();
    const res = await act(kho, s.id, 'record_rejected', { version: s.version });
    expect(res.body.status).toBe('returned_to_us');
    expect(await quarantine()).toBe(before + 2);
  });

  it('B4-05: NCC bù hàng rồi lập đề nghị bù hàng cùng NCC (sourceReturnId); lập lần hai bị chặn', async () => {
    const s = await sent();
    const replaced = (await act(kho, s.id, 'record_replaced', { version: s.version })).body;
    expect(replaced.status).toBe('replaced');
    const body = { supplierId, note: 'Bù hàng', lines: [{ variantId, quantity: 2, unitCost: 40000 }], sourceReturnId: s.id };
    const req = await pur(kho).post('/requests', body);
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    const detail = (await pur(kho).get(`/supplier-returns/${s.id}`)).body;
    expect(detail.replacementRequest).toMatchObject({ type: 'purchase_request', id: req.body.id });
    const again = await pur(kho).post('/requests', body);
    expect([again.status, again.body.errors?.sourceReturnId]).toEqual([422, expect.any(String)]);
  });

  it('B4-04p: người gửi (không phải CEO) không tự ghi kết quả; CEO gửi rồi tự ghi được, có nhãn tự duyệt', async () => {
    const s = await sent(guiVaGhi);
    const self = await act(guiVaGhi, s.id, 'record_rejected', { version: s.version });
    expect([self.status, self.body.code]).toEqual([409, 'second_person_required']);
    const byCeo = await sent(ceo);
    const ok = await act(ceo, byCeo.id, 'record_rejected', { version: byCeo.version });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.statusHistory.at(-1)).toMatchObject({ to: 'returned_to_us', selfApproved: true });
  });

  it('B4-02, B4-02r: CEO trả về cần lý do; người lập có quyền duyệt không tự duyệt gửi phiếu mình lập', async () => {
    const d = await draft();
    const p = (await act(kho, d.id, 'submit', { version: d.version })).body;
    const noReason = await act(ceo, d.id, 'send_back', { version: p.version });
    expect([noReason.status, noReason.body.code]).toEqual([422, 'reason_required']);
    expect((await act(ceo, d.id, 'send_back', { version: p.version, reason: 'Sai số' })).body.status).toBe('draft');

    const own = await draft(guiVaGhi);
    const op = (await act(guiVaGhi, own.id, 'submit', { version: own.version })).body;
    const self = await act(guiVaGhi, own.id, 'approve_send', { version: op.version });
    expect([self.status, self.body.code]).toEqual([409, 'second_person_required']);
  });

  it('B4-07, B4-08: huỷ bắt buộc lý do và cách xử lý; nhập lại tồn chuyển chờ xử lý sang tồn thực, xuất huỷ sinh phiếu nháp', async () => {
    const d = await draft();
    const noDecision = await act(ceo, d.id, 'cancel', { version: d.version, reason: 'Không trả nữa' });
    expect([noDecision.status, noDecision.body.code]).toEqual([422, 'cancel_decision_required']);
    const before = (await inv(ceo).get(`/stock/${variantId}`)).body.level;
    const restock = await act(ceo, d.id, 'cancel', { version: d.version, reason: 'Còn bán được', cancelDecision: 'restock' });
    expect(restock.body).toMatchObject({ status: 'cancelled', cancelDecision: 'restock' });
    expect((await inv(ceo).get(`/stock/${variantId}`)).body.level).toMatchObject({
      onHand: before.onHand + 2,
      quarantine: before.quarantine - 2,
    });

    const w = await draft();
    const p = (await act(kho, w.id, 'submit', { version: w.version })).body;
    const writeOff = await act(ceo, w.id, 'cancel', { version: p.version, reason: 'Huỷ', cancelDecision: 'write_off' });
    expect(writeOff.body.followUps).toEqual([expect.objectContaining({ type: 'stock_document', number: expect.stringMatching(/^XH-/) })]);
    const doc = (await inv(ceo).get(`/documents/${writeOff.body.followUps[0].id}`)).body;
    expect(doc).toMatchObject({ type: 'write_off', area: 'quarantine', status: 'draft', source: { type: 'supplier_return' } });
  });

  it('US-NH-15: huỷ chọn nhập lại tồn giữ giá vốn bình quân hiện tại với phiếu lập tay và phiếu từ hàng lỗi phiếu nhận; nguồn khách trả theo giá dòng kiện (review #279)', async () => {
    const v = (await createVariant(companyId)).variantId;
    await receive(companyId, v, 10, 40000);
    await setBuckets(companyId, v, { quarantine: 20 });
    const cost = async () => (await inv(ceo).get(`/stock/${v}`)).body.level.avgCost as number;
    const make = async (source: string, unitCost: string) => {
      const res = await pur(kho).post('/supplier-returns', { supplierId, note: 'Hàng lỗi', lines: [{ variantId: v, quantity: 2 }] });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      await testPool().query('update product.supplier_returns set source = $2 where id = $1', [res.body.id, source]);
      await testPool().query('update product.supplier_return_lines set unit_cost = $2 where return_id = $1', [res.body.id, unitCost]);
      return res.body as { id: string; version: number };
    };
    const cancel = async (d: { id: string; version: number }) => {
      const res = await act(ceo, d.id, 'cancel', { version: d.version, reason: 'Còn bán được', cancelDecision: 'restock' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    };
    expect(await cost()).toBe(40000);
    // Lập tay: giá trên dòng là bình quân lúc lập (ở đây đã cũ, 10.000); hàng lỗi phiếu nhận: giá đề nghị 90.000
    await cancel(await make('manual', '10000.00'));
    expect(await cost()).toBe(40000);
    await cancel(await make('receipt_defect', '90000.00'));
    expect(await cost()).toBe(40000);
    // Khách trả: theo giá vốn dòng kiện 12.000 → (14 × 40.000 + 2 × 12.000) / 16 = 36.500
    await cancel(await make('customer_return', '12000.00'));
    expect(await cost()).toBe(36500);
  });

  it('B4-01q, B4-03q: Admin, Sale không lập, không gửi; Kho không duyệt gửi', async () => {
    for (const token of [admin, sale]) {
      expect((await pur(token).post('/supplier-returns', { supplierId, note: '', lines: [{ variantId, quantity: 1 }] })).status).toBe(403);
    }
    const d = await draft();
    for (const token of [admin, sale]) expect((await act(token, d.id, 'submit', { version: d.version })).status).toBe(403);
    const p = (await act(kho, d.id, 'submit', { version: d.version })).body;
    const res = await act(kho, d.id, 'approve_send', { version: p.version });
    expect([res.status, res.body.code]).toEqual([403, 'forbidden']);
  });

  it('danh sách lọc theo trạng thái; công ty khác 404', async () => {
    const list = await pur(ceo).get('/supplier-returns?status=sent');
    expect(list.status).toBe(200);
    expect(list.body.items.every((r: { status: string }) => r.status === 'sent')).toBe(true);
    const other = await createCompany();
    const d = await draft();
    expect((await pur(other.ceo.token).get(`/supplier-returns/${d.id}`)).status).toBe(404);
  });
});
