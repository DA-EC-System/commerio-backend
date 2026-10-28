import { beforeAll, describe, expect, it } from 'vitest';
import { GoodsReceipt } from '#src/modules/product/purchasing/api/schemas.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { inv } from '../inventory/helpers.ts';
import { act, BUYER_ROLE, countBody, createReceipt, createSupplier, orderedRequest, pur, type Receipt } from './helpers.ts';

// Ghi kết quả giao thiếu POST /goods-receipts/:id/short-resolution và đóng thiếu dùng chung (spec #109 mục 6.6, AC8, AC9).
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

/** Đề nghị đặt 10 cái, phiếu đầu nhận 6 rồi ghi sổ báo giao thiếu. */
async function shortReceipt() {
  const variantId = (await createVariant(A.companyId)).variantId;
  const req = await orderedRequest(A, A.supplierId, [{ variantId, quantity: 10, unitCost: 1000 }]);
  const r = await createReceipt(A.kho, req.id);
  const counted = await pur(A.kho).put(`/goods-receipts/${r.id}`, countBody(r, [{ announced: 10, accepted: 6, reason: 'Thiếu 4' }]));
  const posted = await pur(A.kho).post(`/goods-receipts/${r.id}/post_short`, { version: counted.body.version });
  expect(posted.status, JSON.stringify(posted.body)).toBe(200);
  return { req, variantId, receipt: GoodsReceipt.parse(posted.body) };
}

const resolve = (token: string, r: Receipt, body: Record<string, unknown>) =>
  pur(token).post(`/goods-receipts/${r.id}/short-resolution`, { note: '', version: r.version, ...body });

describe('ghi kết quả giao thiếu', () => {
  it('AC8: giao bù bằng số phiếu của đề nghị khác → 422 follow_up_invalid; đúng phiếu → resolved; ghi lần hai → 409 resolution_recorded', async () => {
    const { req, receipt } = await shortReceipt();
    const other = await shortReceipt();
    const wrong = await resolve(A.buyer, receipt, { kind: 'follow_up', followUpNumber: other.receipt.number });
    expect(wrong.status).toBe(422);
    expect(wrong.body.code).toBe('follow_up_invalid');
    expect(wrong.body.errors).toEqual({ followUpNumber: 'Không có phiếu nhận này trong cùng đề nghị' });
    expect((await resolve(A.buyer, receipt, { kind: 'follow_up', followUpNumber: receipt.number })).body.code).toBe('follow_up_invalid');

    const second = await createReceipt(A.kho, req.id);
    const res = await resolve(A.buyer, receipt, { kind: 'follow_up', followUpNumber: ` ${second.number.toLowerCase()} `, note: 'NCC giao bù' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const done = GoodsReceipt.parse(res.body);
    expect(done.status).toBe('resolved');
    expect(done.shortResolution).toMatchObject({
      kind: 'follow_up',
      followUp: { type: 'goods_receipt', id: second.id, number: second.number },
      note: 'NCC giao bù',
      by: expect.any(String),
    });
    expect(done.statusHistory).toContainEqual(expect.objectContaining({ from: 'short', to: 'resolved', source: 'user' }));

    const again = await resolve(A.buyer, done, { kind: 'supplier_wrong', note: 'x' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('resolution_recorded');
  });

  it('NCC nhận sai: thiếu ghi chú → 422 errors.note; có ghi chú → resolved', async () => {
    const { receipt } = await shortReceipt();
    const missing = await resolve(A.buyer, receipt, { kind: 'supplier_wrong' });
    expect(missing.status).toBe(422);
    expect(missing.body.errors).toEqual({ note: 'Ghi NCC nhận sai thế nào' });
    const res = await resolve(A.buyer, receipt, { kind: 'supplier_wrong', note: 'NCC đếm nhầm, xác nhận thiếu 4' });
    expect(res.status).toBe(200);
    expect(res.body.shortResolution).toMatchObject({ kind: 'supplier_wrong', followUp: null, note: 'NCC đếm nhầm, xác nhận thiếu 4' });
  });

  it('AC9: mua hàng chọn đóng thiếu → 403; CEO khi còn phiếu đang kiểm → 409 receipt_counting', async () => {
    const { req, receipt } = await shortReceipt();
    const buyer = await resolve(A.buyer, receipt, { kind: 'close_short', note: 'NCC hết hàng' });
    expect(buyer.status).toBe(403);
    expect(buyer.body.code).toBe('forbidden');

    await createReceipt(A.kho, req.id);
    const counting = await resolve(A.ceo, receipt, { kind: 'close_short', note: 'NCC hết hàng' });
    expect(counting.status).toBe(409);
    expect(counting.body.code).toBe('receipt_counting');
  });

  it('AC9: CEO đóng thiếu → đề nghị closed_short, đang về của SKU về 0, phiếu thiếu resolved với kết quả close_short', async () => {
    const { req, variantId, receipt } = await shortReceipt();
    const noReason = await resolve(A.ceo, receipt, { kind: 'close_short' });
    expect(noReason.status).toBe(422);
    expect(noReason.body.code).toBe('reason_required');

    const res = await resolve(A.ceo, receipt, { kind: 'close_short', note: 'NCC hết hàng' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: 'resolved', shortResolution: { kind: 'close_short', note: 'NCC hết hàng' } });
    const request = (await pur(A.buyer).get(`/requests/${req.id}`)).body;
    expect(request).toMatchObject({ status: 'closed_short', outstanding: 0 });
    expect(request.lines[0]).toMatchObject({ closedShort: 4 });
    expect((await inv(A.ceo).get(`/stock/${variantId}`)).body.level.incoming).toBe(0);
  });

  it('đóng thiếu qua POST /requests/:id/close_short cũng tự Đã xử lý phiếu thiếu', async () => {
    const { req, receipt } = await shortReceipt();
    const current = (await pur(A.ceo).get(`/requests/${req.id}`)).body;
    const res = await act(A.ceo, req.id, 'close_short', { version: current.version, reason: 'Đổi NCC khác' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = GoodsReceipt.parse((await pur(A.kho).get(`/goods-receipts/${receipt.id}`)).body);
    expect(after).toMatchObject({ status: 'resolved', shortResolution: { kind: 'close_short', note: 'Đổi NCC khác' } });
  });

  it('phiếu đang kiểm → 409 invalid_transition; kho không có quyền ghi kết quả → 403', async () => {
    const { req } = await shortReceipt();
    const counting = await createReceipt(A.kho, req.id);
    const res = await resolve(A.buyer, counting, { kind: 'supplier_wrong', note: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('invalid_transition');
    expect((await resolve(A.kho, counting, { kind: 'supplier_wrong', note: 'x' })).status).toBe(403);
  });
});
