import { beforeAll, describe, expect, it } from 'vitest';
import { GoodsReceipt, GoodsReceiptPage } from '#src/modules/product/purchasing/api/schemas.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { BUYER_ROLE, countBody, createReceipt, createRequest, createSupplier, orderedRequest, pur, runActions } from './helpers.ts';

// Phiếu nhận /purchasing/goods-receipts: lập, kiểm đếm, huỷ, xem (Documents/21 mục 16.2, spec #109 AC1, AC2, AC11).
let A: { companyId: string; ceo: string; buyer: string; kho: string; supplierId: string; v1: string; v2: string };
let B: { ceo: string };

beforeAll(async () => {
  const a = await createCompany();
  A = {
    companyId: a.companyId,
    ceo: a.ceo.token,
    buyer: (await addMember(a.companyId, BUYER_ROLE)).token,
    kho: (await addMember(a.companyId, 'warehouse')).token,
    supplierId: '',
    v1: (await createVariant(a.companyId)).variantId,
    v2: (await createVariant(a.companyId)).variantId,
  };
  A.supplierId = (await createSupplier(A.ceo)).id;
  B = { ceo: (await createCompany()).ceo.token };
});

const lines = () => [
  { variantId: A.v1, quantity: 10, unitCost: 100000 },
  { variantId: A.v2, quantity: 5, unitCost: 50000 },
];
const ordered = () => orderedRequest(A, A.supplierId, lines());

describe('lập phiếu nhận', () => {
  it('đề nghị mới duyệt, chưa đặt NCC → 409 invalid_transition, current = approved', async () => {
    const draft = await createRequest(A.buyer, A.supplierId, lines());
    const approved = await runActions([[A.buyer, 'submit'], [A.ceo, 'approve']], draft.id, draft.version);
    expect(approved.status).toBe('approved');
    const res = await pur(A.kho).post('/goods-receipts', { requestId: draft.id, deliveryMode: 'waiting', note: '' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'invalid_transition', current: 'approved' });
  });

  it('đề nghị đã đặt → 201 NH-…, dòng là các dòng còn chờ với mọi số bằng 0; người giao đã đi thì hạn kiểm = lúc lập + 24 giờ', async () => {
    const req = await ordered();
    const r = await createReceipt(A.kho, req.id, 'left');
    expect(r).toMatchObject({
      number: expect.stringMatching(/^NH-\d{6}$/),
      status: 'counting',
      deliveryMode: 'left',
      request: { id: req.id },
      supplier: { id: A.supplierId },
      totalAnnounced: 0,
      shortQty: 0,
      postedBy: null,
      shortResolution: null,
      followUps: [],
      attachments: [],
    });
    expect(r.lines.map((l) => [l.lineId, l.variantId, l.outstanding, l.announced, l.short])).toEqual([
      [req.lines[0]!.id, A.v1, 10, 0, 0],
      [req.lines[1]!.id, A.v2, 5, 0, 0],
    ]);
    expect(r.statusHistory).toMatchObject([{ from: null, to: 'counting' }]);
    const { rows } = await testPool().query(
      'select extract(epoch from check_deadline - created_at)::int as s from product.goods_receipts where id = $1',
      [r.id],
    );
    expect(rows[0].s).toBe(86400);

    const waiting = await createReceipt(A.kho, req.id, 'waiting');
    const { rows: w } = await testPool().query('select check_deadline from product.goods_receipts where id = $1', [waiting.id]);
    expect(w[0].check_deadline).toBeNull();
  });

  it('đề nghị đã đóng thiếu → 409 invalid_transition; đề nghị của công ty khác → 422 errors.requestId', async () => {
    const req = await ordered();
    await runActions([[A.ceo, 'close_short', { reason: 'NCC hết hàng' }]], req.id, req.version);
    const closed = await pur(A.kho).post('/goods-receipts', { requestId: req.id, deliveryMode: 'waiting', note: '' });
    expect(closed.status).toBe(409);
    expect(closed.body).toMatchObject({ code: 'invalid_transition', current: 'closed_short' });

    const other = await ordered();
    const foreign = await pur(B.ceo).post('/goods-receipts', { requestId: other.id, deliveryMode: 'waiting', note: '' });
    expect(foreign.status).toBe(422);
    expect(foreign.body.errors).toEqual({ requestId: 'Chọn đề nghị nhập' });
  });

  it('mua hàng không có purchasing.receipt.manage → 403', async () => {
    const req = await ordered();
    const res = await pur(A.buyer).post('/goods-receipts', { requestId: req.id, deliveryMode: 'waiting', note: '' });
    expect(res.status).toBe(403);
  });
});

describe('kiểm đếm', () => {
  it('lưu số đếm, đổi cách giao: số thiếu tự tính, hạn kiểm tính lại, version tăng', async () => {
    const r = await createReceipt(A.kho, (await ordered()).id);
    const body = { ...countBody(r, [{ announced: 10, accepted: 8, reason: 'Thiếu 2' }]), deliveryMode: 'left', note: ' Xe tới 9h ' };
    const res = await pur(A.kho).put(`/goods-receipts/${r.id}`, body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const saved = GoodsReceipt.parse(res.body);
    expect(saved).toMatchObject({ version: 2, deliveryMode: 'left', note: 'Xe tới 9h', totalAnnounced: 10, shortQty: 2 });
    expect(saved.lines[0]).toMatchObject({ announced: 10, accepted: 8, short: 2, reason: 'Thiếu 2' });
    const { rows } = await testPool().query(
      'select extract(epoch from check_deadline - created_at)::int as s from product.goods_receipts where id = $1',
      [r.id],
    );
    expect(rows[0].s).toBe(86400);
  });

  it('vượt báo giao, thiếu mà không ghi lý do → 422 đúng ô', async () => {
    const r = await createReceipt(A.kho, (await ordered()).id);
    const res = await pur(A.kho).put(
      `/goods-receipts/${r.id}`,
      countBody(r, [
        { announced: 5, accepted: 4, defectKept: 2, reason: 'x' },
        { announced: 5, accepted: 4 },
      ]),
    );
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual({
      'lines.0.accepted': 'Nhận đạt, lỗi giữ, trả tại chỗ cộng lại vượt số báo giao',
      'lines.1.reason': 'Ghi lý do khi có thiếu, lỗi hoặc trả tại chỗ',
    });
  });

  it('đạt + lỗi vượt còn chờ → 422 over_outstanding', async () => {
    const r = await createReceipt(A.kho, (await ordered()).id);
    const res = await pur(A.kho).put(`/goods-receipts/${r.id}`, countBody(r, [{ announced: 12, accepted: 11, defectKept: 1, reason: 'Giao dư' }]));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('over_outstanding');
    expect(res.body.errors['lines.0.accepted']).toContain('Còn chờ 10');
  });

  it('lineId không thuộc phiếu hoặc bị lặp → 422 theo ô, không dòng nào bị ghi', async () => {
    const r = await createReceipt(A.kho, (await ordered()).id);
    const body = countBody(r, [{ announced: 3, accepted: 3 }]);
    const foreign = { ...body.lines[0]!, lineId: '00000000-0000-4000-8000-0000000000aa' };
    const res = await pur(A.kho).put(`/goods-receipts/${r.id}`, { ...body, lines: [body.lines[0], body.lines[0], foreign] });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual({ 'lines.1.lineId': 'Dòng bị lặp', 'lines.2.lineId': 'Dòng không thuộc phiếu' });
    const after = GoodsReceipt.parse((await pur(A.kho).get(`/goods-receipts/${r.id}`)).body);
    expect(after.version).toBe(1);
    expect(after.lines.map((l) => l.announced)).toEqual([0, 0]);
  });

  it('gửi tệp đính kèm trước #114 → 422 errors.attachments', async () => {
    const r = await createReceipt(A.kho, (await ordered()).id);
    const res = await pur(A.kho).put(`/goods-receipts/${r.id}`, { ...countBody(r, []), attachmentIds: ['00000000-0000-4000-8000-000000000001'] });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual({ attachments: 'Chưa nhận tệp đính kèm (chờ #114)' });
  });

  it('version cũ → 409 version_conflict kèm current; phiếu đã huỷ → 409 not_draft', async () => {
    const r = await createReceipt(A.kho, (await ordered()).id);
    expect((await pur(A.kho).put(`/goods-receipts/${r.id}`, countBody(r, []))).status).toBe(200);
    const stale = await pur(A.kho).put(`/goods-receipts/${r.id}`, countBody(r, []));
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');
    expect(GoodsReceipt.parse(stale.body.current).version).toBe(2);

    const done = await pur(A.kho).post(`/goods-receipts/${r.id}/cancel`, { version: 2, reason: 'NCC giao nhầm đơn' });
    expect(done.status).toBe(200);
    const res = await pur(A.kho).put(`/goods-receipts/${r.id}`, { ...countBody(r, []), version: 3 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not_draft');
  });
});

describe('huỷ và thao tác', () => {
  it('huỷ không có lý do → 422 reason_required; có lý do → cancelled, lịch sử ghi lý do', async () => {
    const r = await createReceipt(A.kho, (await ordered()).id);
    const missing = await pur(A.kho).post(`/goods-receipts/${r.id}/cancel`, { version: 1 });
    expect(missing.status).toBe(422);
    expect(missing.body.code).toBe('reason_required');
    const res = await pur(A.kho).post(`/goods-receipts/${r.id}/cancel`, { version: 1, reason: 'Lập nhầm' });
    expect(res.status).toBe(200);
    const done = GoodsReceipt.parse(res.body);
    expect(done.status).toBe('cancelled');
    expect(done.statusHistory.at(-1)).toMatchObject({ from: 'counting', to: 'cancelled', reason: 'Lập nhầm' });
  });

  it('thao tác lạ → 404', async () => {
    const r = await createReceipt(A.kho, (await ordered()).id);
    expect((await pur(A.kho).post(`/goods-receipts/${r.id}/approve`, { version: 1 })).status).toBe(404);
  });
});

describe('xem', () => {
  it('phiếu của công ty khác → 404; danh sách lọc theo đề nghị, trạng thái, số phiếu', async () => {
    const req = await ordered();
    const r1 = await createReceipt(A.kho, req.id);
    const r2 = await createReceipt(A.kho, req.id);
    await pur(A.kho).post(`/goods-receipts/${r2.id}/cancel`, { version: 1, reason: 'Lập trùng' });

    expect((await pur(B.ceo).get(`/goods-receipts/${r1.id}`)).status).toBe(404);
    expect((await pur(A.kho).get('/goods-receipts/khong-phai-uuid')).status).toBe(404);

    const byRequest = GoodsReceiptPage.parse((await pur(A.buyer).get(`/goods-receipts?requestId=${req.id}`)).body);
    expect(byRequest.items.map((x) => x.id)).toEqual([r2.id, r1.id]);
    expect(byRequest.items[1]).toMatchObject({ request: { id: req.id, number: req.number }, supplier: { id: A.supplierId } });

    const counting = GoodsReceiptPage.parse((await pur(A.kho).get(`/goods-receipts?requestId=${req.id}&status=counting`)).body);
    expect(counting.items.map((x) => x.id)).toEqual([r1.id]);

    const search = GoodsReceiptPage.parse((await pur(A.kho).get(`/goods-receipts?search=${r1.number.toLowerCase()}`)).body);
    expect(search.items.map((x) => x.id)).toEqual([r1.id]);
  });
});
