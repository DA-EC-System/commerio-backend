import { beforeAll, describe, expect, it } from 'vitest';
import { GoodsReceipt } from '#src/modules/product/purchasing/api/schemas.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany, createCustomRole } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { raceBehindLock } from '../../helpers/locks.ts';
import { inv } from '../inventory/helpers.ts';
import {
  BUYER_ROLE,
  type Count,
  countBody,
  createReceipt,
  createRequest,
  createSupplier,
  orderedRequest,
  pur,
  type Receipt,
  runActions,
} from './helpers.ts';

// Ghi sổ phiếu nhận: post, post_short (spec #109 mục 6.5, AC3–AC7).
let A: { companyId: string; ceo: string; buyer: string; kho: string; supplierId: string };

beforeAll(async () => {
  const a = await createCompany();
  A = {
    companyId: a.companyId,
    ceo: a.ceo.token,
    buyer: (await addMember(a.companyId, BUYER_ROLE)).token,
    kho: (await addMember(a.companyId, 'warehouse')).token,
    supplierId: '',
  };
  A.supplierId = (await createSupplier(A.ceo)).id;
});

const newVariant = async () => (await createVariant(A.companyId)).variantId;
/** Các con số tồn của SKU qua API inventory (CEO thấy giá vốn). */
const stockOf = async (v: string) => (await inv(A.ceo).get(`/stock/${v}`)).body.level;

/** Phiếu đang kiểm của một đề nghị đã đặt, đã lưu số đếm. */
async function counted(token: string, requestId: string, counts: Partial<Count>[]): Promise<Receipt> {
  const r = await createReceipt(A.kho, requestId);
  const res = await pur(token).put(`/goods-receipts/${r.id}`, countBody(r, counts));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return GoodsReceipt.parse(res.body);
}

const post = (token: string, r: Receipt, action: 'post' | 'post_short' = 'post') =>
  pur(token).post(`/goods-receipts/${r.id}/${action}`, { version: r.version });

async function rows(sql: string, params: unknown[]) {
  return (await testPool().query(sql, params)).rows;
}

describe('ghi sổ phiếu nhận', () => {
  it('AC5: đạt 55, lỗi 2, giá 100.000 → tồn, chờ xử lý, giá vốn, thẻ kho, phiếu trả NCC nháp, outbox', async () => {
    const v = await newVariant();
    const req = await orderedRequest(A, A.supplierId, [{ variantId: v, quantity: 60, unitCost: 100000 }]);
    const r = await counted(A.kho, req.id, [{ announced: 60, accepted: 55, defectKept: 2, reason: 'Lỗi 2, thiếu 3' }]);

    const res = await post(A.kho, r, 'post_short');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const posted = GoodsReceipt.parse(res.body);
    expect(posted).toMatchObject({ status: 'short', postedBy: expect.any(String), postedAt: expect.any(String) });
    expect(posted.followUps).toEqual([{ type: 'supplier_return', id: expect.any(String), number: expect.stringMatching(/^TN-\d{6}$/) }]);

    const stock = await stockOf(v);
    expect(stock).toMatchObject({ onHand: 55, quarantine: 2, avgCost: 100000, incoming: 3 });
    expect(await rows('select bucket, qty_change from product.stock_moves where source_id = $1 order by id', [r.id])).toEqual([
      { bucket: 'on_hand', qty_change: 55 },
      { bucket: 'quarantine', qty_change: 2 },
    ]);

    const returnId = posted.followUps[0]!.id;
    expect(await rows('select status, source, source_id, supplier_id, created_by from product.supplier_returns where id = $1', [returnId])).toEqual([
      { status: 'draft', source: 'receipt_defect', source_id: r.id, supplier_id: A.supplierId, created_by: null },
    ]);
    expect(await rows('select variant_id, quantity, unit_cost from product.supplier_return_lines where return_id = $1', [returnId])).toEqual([
      { variant_id: v, quantity: 2, unit_cost: '100000.00' },
    ]);
    expect(await rows("select payload from core.outbox_messages where type = 'purchasing.goods_receipt_posted' and key = $1", [r.id])).toEqual([
      { payload: { receiptId: r.id, requestId: req.id, lines: [{ variantId: v, accepted: 55, defective: 2 }] } },
    ]);
    expect(await rows("select count(*)::int as n from core.outbox_messages where type = 'inventory.stock_changed' and key = $1", [v])).toEqual([
      { n: 1 },
    ]);
    expect(await rows('select self_approved from product.goods_receipts where id = $1', [r.id])).toEqual([{ self_approved: false }]);

    const request = (await pur(A.buyer).get(`/requests/${req.id}`)).body;
    expect(request).toMatchObject({ status: 'partially_received', supplierShort: true });
    expect(request.lines[0]).toMatchObject({ received: 55, defective: 2, outstanding: 3 });
    // Lịch sử xếp theo giờ bắt đầu giao dịch: tìm bước chuyển, không giả định nó đứng cuối (giờ container có thể nhảy).
    expect(request.statusHistory).toContainEqual(expect.objectContaining({ from: 'ordered', to: 'partially_received', source: 'system' }));
  });

  it('AC6: phiếu đầu thiếu → đề nghị nhận một phần; phiếu sau nhận đủ → nhận xong, phiếu đầu tự Đã xử lý trỏ phiếu sau', async () => {
    const v = await newVariant();
    const req = await orderedRequest(A, A.supplierId, [{ variantId: v, quantity: 10, unitCost: 80000 }]);
    const first = await counted(A.kho, req.id, [{ announced: 10, accepted: 6, reason: 'Thiếu 4' }]);
    expect((await post(A.kho, first, 'post_short')).status).toBe(200);

    const second = await counted(A.kho, req.id, [{ announced: 4, accepted: 4 }]);
    expect(second.lines[0]!.outstanding).toBe(4);
    const res = await post(A.kho, second);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('matched');

    const request = (await pur(A.buyer).get(`/requests/${req.id}`)).body;
    expect(request.status).toBe('received');
    const resolved = GoodsReceipt.parse((await pur(A.kho).get(`/goods-receipts/${first.id}`)).body);
    expect(resolved.status).toBe('resolved');
    expect(resolved.shortResolution).toMatchObject({
      kind: 'follow_up',
      followUp: { type: 'goods_receipt', id: second.id, number: second.number },
    });
    expect(resolved.statusHistory).toContainEqual(expect.objectContaining({ from: 'short', to: 'resolved', source: 'system' }));
    expect(await stockOf(v)).toMatchObject({ onHand: 10, incoming: 0 });
  });

  it('AC3: người lập đề nghị tự ghi sổ (không phải CEO, công ty nhiều người) → 409 second_person_required', async () => {
    const role = await createCustomRole(A.companyId, ['purchasing.request.manage', 'purchasing.receipt.manage']);
    const both = (await addMember(A.companyId, role)).token;
    const v = await newVariant();
    const draft = await createRequest(both, A.supplierId, [{ variantId: v, quantity: 5, unitCost: 1000 }]);
    await runActions([[both, 'submit'], [A.ceo, 'approve'], [both, 'order']], draft.id, draft.version);
    const r = await counted(both, draft.id, [{ announced: 5, accepted: 5 }]);
    const res = await post(both, r);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('second_person_required');
  });

  it('AC3: CEO lập đề nghị rồi tự ghi sổ → 200, phiếu đánh dấu self_approved', async () => {
    const v = await newVariant();
    const draft = await createRequest(A.ceo, A.supplierId, [{ variantId: v, quantity: 5, unitCost: 1000 }]);
    await runActions([[A.ceo, 'submit'], [A.ceo, 'approve'], [A.ceo, 'order']], draft.id, draft.version);
    const r = await counted(A.ceo, draft.id, [{ announced: 5, accepted: 5 }]);
    expect((await post(A.ceo, r)).status).toBe(200);
    expect(await rows('select self_approved from product.goods_receipts where id = $1', [r.id])).toEqual([{ self_approved: true }]);
  });

  it('AC4: post khi có thiếu → 409 has_shortage; post_short khi không thiếu → 409 no_shortage', async () => {
    const req = await orderedRequest(A, A.supplierId, [{ variantId: await newVariant(), quantity: 5, unitCost: 1000 }]);
    const short = await counted(A.kho, req.id, [{ announced: 5, accepted: 3, reason: 'Thiếu 2' }]);
    expect((await post(A.kho, short)).body.code).toBe('has_shortage');
    const full = await counted(A.kho, req.id, [{ announced: 5, accepted: 5 }]);
    expect((await post(A.kho, full, 'post_short')).body.code).toBe('no_shortage');
  });

  it('chưa nhập số báo giao → 409 empty_document', async () => {
    const req = await orderedRequest(A, A.supplierId, [{ variantId: await newVariant(), quantity: 5, unitCost: 1000 }]);
    const r = await createReceipt(A.kho, req.id);
    const res = await post(A.kho, r);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('empty_document');
  });

  it('AC7: hai phiếu cùng nhận đủ còn chờ, ghi sổ song song → một 200, một 422 over_outstanding; tồn tăng một lần', async () => {
    const v = await newVariant();
    const req = await orderedRequest(A, A.supplierId, [{ variantId: v, quantity: 10, unitCost: 1000 }]);
    const r1 = await counted(A.kho, req.id, [{ announced: 10, accepted: 10 }]);
    const r2 = await counted(A.kho, req.id, [{ announced: 10, accepted: 10 }]);
    // Đề nghị do mua hàng lập, kho là người thứ hai.
    const results = await raceBehindLock(
      (h) => h.query('select 1 from product.purchase_requests where id = $1 for update', [req.id]),
      2,
      () => Promise.all([post(A.kho, r1), post(A.kho, r2)]),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
    expect(results.find((r) => r.status === 422)!.body.code).toBe('over_outstanding');
    expect((await stockOf(v)).onHand).toBe(10);
  });

  it('bấm ghi sổ lần hai với version cũ → 409 version_conflict; tồn và phiếu trả NCC không đổi', async () => {
    const v = await newVariant();
    const req = await orderedRequest(A, A.supplierId, [{ variantId: v, quantity: 5, unitCost: 1000 }]);
    const r = await counted(A.kho, req.id, [{ announced: 5, accepted: 4, defectKept: 1, reason: 'Móp 1' }]);
    expect((await post(A.kho, r)).status).toBe(200);
    const again = await post(A.kho, r);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('version_conflict');
    expect(await stockOf(v)).toMatchObject({ onHand: 4, quarantine: 1 });
    expect(await rows('select count(*)::int as n from product.supplier_returns where source_id = $1', [r.id])).toEqual([{ n: 1 }]);
  });

  it('chỉ có hàng trả tại chỗ → ghi sổ được, không thẻ kho, không stock_changed, không phiếu trả NCC', async () => {
    const v = await newVariant();
    const req = await orderedRequest(A, A.supplierId, [{ variantId: v, quantity: 5, unitCost: 1000 }]);
    const r = await counted(A.kho, req.id, [{ announced: 5, returnedOnSpot: 5, reason: 'Hỏng cả 5, trả người giao' }]);
    const res = await post(A.kho, r);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(GoodsReceipt.parse(res.body)).toMatchObject({ status: 'matched', followUps: [] });
    expect(await rows('select count(*)::int as n from product.stock_moves where source_id = $1', [r.id])).toEqual([{ n: 0 }]);
    expect(await rows("select count(*)::int as n from core.outbox_messages where type = 'inventory.stock_changed' and key = $1", [v])).toEqual([
      { n: 0 },
    ]);
    expect(await rows('select count(*)::int as n from product.supplier_returns where source_id = $1', [r.id])).toEqual([{ n: 0 }]);
    expect((await pur(A.buyer).get(`/requests/${req.id}`)).body).toMatchObject({ status: 'partially_received', outstanding: 5 });
  });
});
