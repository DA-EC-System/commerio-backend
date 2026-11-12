// Yêu cầu trả (#202, Documents/21 §20, §20.1, §15.3). Mã ca theo sơ đồ D3 (`kiem-thu/ca-theo-so-do.md`).
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { ingestMarketplaceOrder, type PlatformOrder } from '#src/modules/order/index.ts';
import { ReceiveResult, ReturnListResponse, ReturnRequest, UnmatchedList, UnmatchedParcel } from '#src/modules/order/sales/api/return-schemas.ts';
import { type ReturnStockPort, setReturnStockPort } from '#src/modules/order/sales/service/return-stock-port.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { onReturnInspected } from '#src/modules/order/sales/service/return-ingest.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { fakeAdapter } from '../../channel/channel/helpers.ts';
import { noLineInfo, noOrderInfo, noShipping } from './helpers.ts';

const decideReturn = vi.fn(async () => {});
const confirmReturnReceived = vi.fn(async () => {});
const returnReasons = vi.fn(async () => [
  { id: '1001', label: 'Hàng đã qua sử dụng', requiresImage: false },
  { id: '1002', label: 'Thiếu phụ kiện', requiresImage: true },
]);
registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
    },
    decideReturn,
    confirmReturnReceived,
    returnReasons,
  }),
);
afterAll(() => resetAdapters());
afterEach(() => {
  setReturnStockPort();
  decideReturn.mockClear();
  confirmReturnReceived.mockClear();
});

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
let shopId: string;
let variantId: string;
let otherVariant: string;
let sku: string;
let sale: Awaited<ReturnType<typeof addMember>>;
let warehouse: Awaited<ReturnType<typeof addMember>>;
const auth = (r: request.Test, token = company.ceo.token) => r.set('Authorization', `Bearer ${token}`);

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  const res = await auth(app().post('/api/v1/channel/shops/lazada/token')).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  shopId = res.body.shop.id;
  await testPool().query(`update channel.shops set status = 'active', order_cutoff_at = now() where id = $1`, [shopId]);
  ({ variantId, sku } = await createVariant(company.companyId));
  ({ variantId: otherVariant } = await createVariant(company.companyId));
  sale = await addMember(company.companyId, 'sale');
  warehouse = await addMember(company.companyId, 'warehouse');
});

/** Đơn sàn đã giao một kiện hai món, kèm yêu cầu trả từ sàn seed thẳng vào DB (issue: "kiện seed thẳng vào DB"). */
async function seedReturn(status: 'requested' | 'awaiting_return' | 'rejected' = 'requested', kind: 'return' | 'refund' = 'return') {
  const id = `LZ-${randomUUID().slice(0, 8)}`;
  const order: PlatformOrder = {
    shopId,
    externalOrderId: id,
    rawStatus: 'delivered',
    paid: true,
    isCod: false,
    placedAt: new Date(),
    shipBy: null,
    shippingAddress: null,
    shippingFee: '0',
    cancelRequested: false,
    info: noOrderInfo,
    lines: [1, 2].map((n) => ({
      externalLineId: `${id}-${n}`,
      variantId,
      sellerSku: sku,
      productName: 'Áo',
      unitPrice: '32000',
      sellerDiscount: '0',
      platformDiscount: '0',
      packageCode: `FP-${id}`,
      trackingCode: null,
      rawStatus: 'delivered',
      status: 'delivered' as const,
      info: noLineInfo,
      shipping: noShipping,
    })),
  };
  const { orderId } = await withCompany(company.companyId, () => ingestMarketplaceOrder(order));
  const db = testPool();
  const code = `YCT-${randomUUID().slice(0, 6)}`;
  const tracking = `JNT-${randomUUID().slice(0, 8)}`;
  const req = await db.query<{ id: string }>(
    `insert into "order".return_requests (company_id, code, order_id, source, shop_id, external_return_id, status, reason, refund_amount, return_tracking_code, raw_marketplace_status, kind)
     values ($1, $2, $3, 'marketplace', $4, $5, $6, 'Khách đổi ý', 64000, $7, 'REFUND_PENDING', $8) returning id`,
    [company.companyId, code, orderId, shopId, randomUUID().slice(0, 12), status, tracking, kind],
  );
  const lines = await db.query<{ id: string; package_id: string }>(
    `select ol.id, pl.package_id from "order".order_lines ol join "order".package_lines pl on pl.order_line_id = ol.id where ol.order_id = $1 order by ol.external_line_id`,
    [orderId],
  );
  for (const [i, l] of lines.rows.entries()) {
    await db.query(
      `insert into "order".return_request_lines (company_id, request_id, order_line_id, package_id, variant_id, quantity, unit_price, unit_cost, external_line_id)
       values ($1, $2, $3, $4, $5, 1, 32000, 15000, $6)`,
      [company.companyId, req.rows[0]!.id, l.id, l.package_id, variantId, `RL-${i}`],
    );
  }
  return { id: req.rows[0]!.id, code, tracking, orderId };
}

const detail = async (id: string, token?: string) => ReturnRequest.parse((await auth(app().get(`/api/v1/returns/${id}`), token)).body);
const act = (id: string, action: string, body: object, token?: string) => auth(app().post(`/api/v1/returns/${id}/${action}`), token).send(body);
const receive = (body: object, token = warehouse.token) => auth(app().post('/api/v1/returns/receive'), token).send(body);

/** Số chờ xử lý của SKU (0 khi chưa có dòng tồn). */
async function quarantineOf(id: string): Promise<number> {
  const r = await testPool().query(`select quarantine from product.stock_levels where variant_id = $1`, [id]);
  return r.rows[0]?.quarantine ?? 0;
}

/** Cổng kho giả: ghi lại lời gọi, trả phiếu mới (test không cần kho thật). */
function fakePort() {
  const calls: Parameters<ReturnStockPort['receiveBack']>[] = [];
  setReturnStockPort({
    async receiveBack(...args) {
      calls.push(args);
      return { documentId: randomUUID(), number: `KT-${calls.length}` };
    },
  });
  return calls;
}

describe('xem yêu cầu trả (§20)', () => {
  it('danh sách lọc, tìm, đếm theo trạng thái; chi tiết đủ dòng, kiện, lịch sử; công ty khác 404', async () => {
    const r = await seedReturn('requested');
    const list = ReturnListResponse.parse((await auth(app().get(`/api/v1/returns?search=${r.code}`))).body);
    expect(list.items.map((i) => [i.code, i.totalQty, i.refundAmount, i.shopName])).toEqual([[r.code, 2, 64000, 'Shop thử']]);
    expect(list.counts.requested).toBe(1);
    expect(ReturnListResponse.parse((await auth(app().get(`/api/v1/returns?status=closed&search=${r.code}`))).body).total).toBe(0);
    const d = await detail(r.id);
    expect(d.lines.map((l) => [l.variantId, l.quantity, l.unitPrice, l.packageCode?.startsWith('KH-')])).toEqual([
      [variantId, 1, 32000, true],
      [variantId, 1, 32000, true],
    ]);
    expect(d.platform).toMatchObject({ reverseStatus: 'REFUND_PENDING', disputeInProgress: false });
    const other = await createCompany();
    expect((await auth(app().get(`/api/v1/returns/${r.id}`), other.ceo.token)).status).toBe(404);
    expect((await auth(app().get('/api/v1/returns/khong-phai-uuid'))).status).toBe(404);
  });

  it('thiếu token 401, Kho không có sales.return.process thì 403 trước khi kiểm body', async () => {
    const r = await seedReturn('requested');
    expect((await app().get('/api/v1/returns')).status).toBe(401);
    expect((await act(r.id, 'accept', {}, warehouse.token)).status).toBe(403);
  });
});

describe('thao tác (§20, §20.1)', () => {
  it('chấp nhận: báo sàn kèm mã dòng rồi ghi; lệch version 409; sai trạng thái 409', async () => {
    const r = await seedReturn('requested');
    expect((await act(r.id, 'accept', { version: 9 })).body.code).toBe('version_conflict');
    const res = await act(r.id, 'accept', { version: 1 }, sale.token);
    expect(res.status).toBe(200);
    expect(ReturnRequest.parse(res.body)).toMatchObject({ status: 'awaiting_return', version: 2 });
    expect(decideReturn).toHaveBeenCalledWith(expect.any(String), expect.any(String), ['RL-0', 'RL-1'], 'accept', { kind: 'return' });
    const again = await act(r.id, 'accept', { version: 2 });
    expect([again.status, again.body.code]).toEqual([409, 'invalid_transition']);
    const history = (await detail(r.id)).statusHistory;
    expect(history.at(-1)).toMatchObject({ from: 'requested', to: 'awaiting_return', source: 'user' });
  });

  it('từ chối yêu cầu sàn bắt buộc reasonId trong danh sách sàn; lý do cần ảnh thì đòi ảnh', async () => {
    const r = await seedReturn('requested');
    expect((await act(r.id, 'reject', { version: 1 })).body.errors).toEqual({ reasonId: expect.any(String) });
    expect((await act(r.id, 'reject', { version: 1, reasonId: '9999' })).body.errors).toEqual({ reasonId: expect.any(String) });
    expect((await act(r.id, 'reject', { version: 1, reasonId: '1002' })).body.errors).toEqual({ attachmentIds: expect.any(String) });
    expect(decideReturn).not.toHaveBeenCalled();
    const ok = ReturnRequest.parse((await act(r.id, 'reject', { version: 1, reasonId: '1001', comment: 'Ảnh cho thấy đã dùng' })).body);
    expect(ok).toMatchObject({ status: 'rejected', rejectReason: { id: '1001', label: 'Hàng đã qua sử dụng' } });
    expect(decideReturn).toHaveBeenCalledWith(expect.any(String), expect.any(String), ['RL-0', 'RL-1'], 'reject', {
      reasonId: '1001',
      comment: 'Ảnh cho thấy đã dùng',
      kind: 'return',
    });
  });

  it('chỉ hoàn tiền (khách giữ hàng): refund_only, refunded, phát sales.return_refunded, đơn không còn cờ', async () => {
    const r = await seedReturn('requested');
    const res = ReturnRequest.parse((await act(r.id, 'refund-only', { version: 1 })).body);
    expect(res).toMatchObject({ status: 'refund_only', money: { refunded: true, refundAmount: 64000 } });
    expect(decideReturn).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(Array), 'refund', { kind: 'return' });
    const event = await testPool().query(`select payload from core.outbox_messages where type = 'sales.return_refunded' and payload->>'returnRequestId' = $1`, [r.id]);
    expect(event.rows.map((e) => e.payload)).toEqual([expect.objectContaining({ orderId: r.orderId, shopId, refundAmount: '64000.00' })]);
    const order = await auth(app().get(`/api/v1/sales/orders/${r.orderId}`));
    expect(order.body.flags).not.toContain('return_requested');
  });

  it('yêu cầu chỉ hoàn tiền: không đồng ý trả hàng được; từ chối theo lý do từ chối hoàn tiền; báo sàn kèm loại', async () => {
    const r = await seedReturn('requested', 'refund');
    expect(ReturnRequest.parse((await detail(r.id))).kind).toBe('refund');
    const accept = await act(r.id, 'accept', { version: 1 });
    expect([accept.status, accept.body.code]).toEqual([409, 'refund_only_request']);
    returnReasons.mockClear();
    const res = ReturnRequest.parse((await act(r.id, 'reject', { version: 1, reasonId: '1001' })).body);
    expect(res.status).toBe('rejected');
    expect(returnReasons).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'refuse-refund');
    expect(decideReturn).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(Array), 'reject', { reasonId: '1001', kind: 'refund' });
  });

  it('khách không gửi hàng: bắt buộc lý do, đóng no_show, không báo sàn', async () => {
    const r = await seedReturn('awaiting_return');
    const missing = await act(r.id, 'no-show', { version: 1 });
    expect([missing.status, missing.body.code]).toEqual([422, 'reason_required']);
    const res = ReturnRequest.parse((await act(r.id, 'no-show', { version: 1, reason: 'Quá hạn gửi hàng' })).body);
    expect(res).toMatchObject({ status: 'closed', closeResult: 'no_show', money: { refunded: false } });
    expect(decideReturn).not.toHaveBeenCalled();
  });

  it('ghi nhận sàn xử cho khách: rejected → awaiting_return, không báo sàn', async () => {
    const r = await seedReturn('rejected');
    expect(ReturnRequest.parse((await act(r.id, 'platform-reopen', { version: 1 })).body).status).toBe('awaiting_return');
    expect(decideReturn).not.toHaveBeenCalled();
  });
});

describe('quét nhận hàng trả (§20, §15.3)', () => {
  it('lines sai thì 422 theo bảng §15.3, không ghi gì', async () => {
    const r = await seedReturn('awaiting_return');
    const errorsOf = async (lines: unknown) => (await receive({ code: r.code, lines })).body.errors;
    expect(await errorsOf('x')).toEqual({ lines: expect.any(String) });
    expect(await errorsOf([{ variantId, quantity: -1 }])).toEqual({ 'lines.0.quantity': expect.any(String) });
    expect(await errorsOf([{ variantId, quantity: 1.5 }])).toEqual({ 'lines.0.quantity': expect.any(String) });
    expect(await errorsOf([{ variantId, quantity: 1 }, { variantId, quantity: 0 }])).toEqual({ 'lines.1.variantId': 'Biến thể bị lặp' });
    expect(await errorsOf([{ variantId: randomUUID(), quantity: 1 }])).toEqual({ 'lines.0.variantId': expect.any(String) });
    expect((await detail(r.id)).status).toBe('awaiting_return');
  });

  it('gộp dòng: món vắng quét 0, món ngoài yêu cầu dự kiến 0; yêu cầu sang received, báo sàn đã nhận', async () => {
    const calls = fakePort();
    const r = await seedReturn('awaiting_return');
    const res = ReceiveResult.parse((await receive({ code: r.tracking, lines: [{ variantId: otherVariant, quantity: 1 }] })).body);
    expect(calls[0]![0]).toEqual({ type: 'return_request', id: r.id });
    expect(calls[0]![1]).toEqual([
      { variantId, expected: 2, scanned: 0 },
      { variantId: otherVariant, expected: 0, scanned: 1 },
    ]);
    expect(calls[0]![2]).toMatchObject({ actorId: warehouse.accountId, number: r.code, orderId: r.orderId, shopId, unitCosts: { [variantId]: '15000.00' } });
    expect(res.kind).toBe('matched');
    const d = await detail(r.id);
    expect(d).toMatchObject({ status: 'received', inspection: { number: 'KT-1' }, receivedBy: { id: warehouse.accountId } });
    expect(confirmReturnReceived).toHaveBeenCalledWith(expect.any(String), expect.any(String), ['RL-0', 'RL-1']);
  });

  it('dòng yêu cầu chưa ghép SKU, không quét món nào: 422 validation_failed errors.lines, yêu cầu giữ awaiting_return', async () => {
    const r = await seedReturn('awaiting_return');
    await testPool().query(`update "order".return_request_lines set variant_id = null where request_id = $1`, [r.id]);
    const res = await receive({ code: r.code });
    expect([res.status, res.body.code, Object.keys(res.body.errors ?? {})]).toEqual([422, 'validation_failed', ['lines']]);
    expect((await detail(r.id)).status).toBe('awaiting_return');
  });

  it('không gửi lines thì coi như quét đủ; yêu cầu chưa chờ hàng về thì 409 return_not_awaiting', async () => {
    const calls = fakePort();
    const r = await seedReturn('awaiting_return');
    await receive({ code: r.code });
    expect(calls[0]![1]).toEqual([{ variantId, expected: 2, scanned: 2 }]);
    const again = await receive({ code: r.code });
    expect([again.status, again.body.code]).toEqual([409, 'return_not_awaiting']);
  });

  it('cổng thật (#208): lập phiếu kiểm hàng hoàn nháp có số dự kiến, số quét; chờ xử lý tăng theo số quét', async () => {
    const r = await seedReturn('awaiting_return');
    const before = await quarantineOf(variantId);
    expect((await receive({ code: r.code, lines: [{ variantId, quantity: 1 }] })).status).toBe(200);
    const doc = await testPool().query(
      `select d.kind, d.status, l.expected_qty, l.scanned_qty from product.stock_documents d join product.stock_document_lines l on l.document_id = d.id
       where d.source_type = 'return_request' and d.source_id = $1`,
      [r.id],
    );
    expect(doc.rows).toEqual([{ kind: 'return_inspection', status: 'draft', expected_qty: 2, scanned_qty: 1 }]);
    expect(await quarantineOf(variantId)).toBe(before + 1);
  });
});

describe('kiện trả không khớp (§20)', () => {
  it('không gửi lines: lưu kiện mở, phiếu không dòng; cổng thật (#208): có lines thì phiếu nguồn kiện, gắn vào yêu cầu thì phiếu chuyển sang yêu cầu, chờ xử lý không cộng lần hai', async () => {
    const scanned = `UNK-${randomUUID().slice(0, 8)}`;
    const res = ReceiveResult.parse((await receive({ code: scanned, note: 'Hộp móp' })).body);
    // §20: kiện không khớp luôn có phiếu kiểm hàng hoàn, chưa rõ SKU thì phiếu không dòng
    expect(res).toMatchObject({ kind: 'unmatched', parcel: { scannedCode: scanned, status: 'open', lines: [] } });
    if (res.kind !== 'unmatched') throw new Error('phải là kiện không khớp');
    expect(res.parcel.inspection).not.toBeNull();

    const before = await quarantineOf(variantId);
    const withLines = ReceiveResult.parse((await receive({ code: `UNK-${randomUUID().slice(0, 8)}`, lines: [{ variantId, quantity: 2 }] })).body);
    if (withLines.kind !== 'unmatched') throw new Error('phải là kiện không khớp');
    expect(withLines.parcel.inspection).not.toBeNull();
    const docOf = async () =>
      (
        await testPool().query(
          `select d.source_type, d.source_id, l.expected_qty, l.scanned_qty from product.stock_documents d
           join product.stock_document_lines l on l.document_id = d.id where d.id = $1`,
          [withLines.parcel.inspection!.documentId],
        )
      ).rows;
    expect(await docOf()).toEqual([{ source_type: 'unmatched_parcel', source_id: withLines.parcel.id, expected_qty: 2, scanned_qty: 2 }]);
    expect(await quarantineOf(variantId)).toBe(before + 2);

    const r = await seedReturn('awaiting_return');
    const attached = await auth(app().post(`/api/v1/returns/unmatched/${withLines.parcel.id}/attach`), warehouse.token).send({ version: 1, returnRequestId: r.id });
    expect(attached.status).toBe(200);
    expect(await docOf()).toEqual([{ source_type: 'return_request', source_id: r.id, expected_qty: 2, scanned_qty: 2 }]);
    expect(await quarantineOf(variantId)).toBe(before + 2);
    expect(await detail(r.id)).toMatchObject({ status: 'received', inspection: { id: withLines.parcel.inspection!.documentId } });
  });

  it('phiếu của kiện đã ghi sổ trước khi gắn: gắn vào yêu cầu thì phát inventory.return_inspected theo đơn của yêu cầu', async () => {
    const res = ReceiveResult.parse((await receive({ code: `UNK-${randomUUID().slice(0, 8)}`, lines: [{ variantId, quantity: 2 }] })).body);
    if (res.kind !== 'unmatched') throw new Error('phải là kiện không khớp');
    const docId = res.parcel.inspection!.documentId;
    // Kho chia và ghi sổ phiếu ngay (Documents/21 §20); dựng thẳng trạng thái đã ghi sổ, luồng ghi sổ có test riêng ở inventory.
    await testPool().query(`update product.stock_document_lines set resell_qty = 2, damaged_qty = 0, to_supplier_qty = 0 where document_id = $1`, [docId]);
    await testPool().query(`update product.stock_documents set status = 'posted', posted_at = now() where id = $1`, [docId]);

    const r = await seedReturn('awaiting_return');
    const attached = await auth(app().post(`/api/v1/returns/unmatched/${res.parcel.id}/attach`), warehouse.token).send({ version: 1, returnRequestId: r.id });
    expect(attached.status).toBe(200);
    const ev = await testPool().query(
      `select payload from core.outbox_messages where type = 'inventory.return_inspected' and payload->>'inspectionId' = $1`,
      [docId],
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0].payload).toMatchObject({ orderId: r.orderId, shopId, lines: [{ variantId, resellable: 2 }] });
    // Khép vòng: consumer của sales đóng yêu cầu khi nhận sự kiện
    await withCompany(company.companyId, () => onReturnInspected({ payload: ev.rows[0].payload }));
    expect((await detail(r.id)).status).toBe('closed');
  });

  it('có lines: lưu dòng, receiveBack nguồn unmatched_parcel với số quét (inventory đặt dự kiến = quét); gắn vào yêu cầu mở sau thì yêu cầu received', async () => {
    const calls = fakePort();
    const res = ReceiveResult.parse((await receive({ code: `UNK-${randomUUID().slice(0, 8)}`, lines: [{ variantId, quantity: 2 }] })).body);
    if (res.kind !== 'unmatched') throw new Error('phải là kiện không khớp');
    expect(calls[0]![0]).toEqual({ type: 'unmatched_parcel', id: res.parcel.id });
    expect(calls[0]![1]).toEqual([{ variantId, expected: 0, scanned: 2 }]);
    expect(res.parcel).toMatchObject({ lines: [{ variantId, quantity: 2 }], inspection: { number: 'KT-1' } });
    const rows = await testPool().query(`select variant_id, quantity from "order".unmatched_return_parcel_lines where parcel_id = $1`, [res.parcel.id]);
    expect(rows.rows).toEqual([{ variant_id: variantId, quantity: 2 }]);

    const r = await seedReturn('awaiting_return');
    const attached = UnmatchedParcel.parse(
      (await auth(app().post(`/api/v1/returns/unmatched/${res.parcel.id}/attach`), warehouse.token).send({ version: 1, returnRequestId: r.id })).body,
    );
    expect(attached).toMatchObject({ status: 'attached', returnRequest: { id: r.id, code: r.code } });
    expect(calls[1]![0]).toEqual({ type: 'return_request', id: r.id });
    expect(calls[1]![1]).toEqual([{ variantId, expected: 2, scanned: 2 }]);
    expect(calls[1]![2]).toMatchObject({ fromUnmatchedParcelId: res.parcel.id });
    expect((await detail(r.id)).status).toBe('received');
    const again = await auth(app().post(`/api/v1/returns/unmatched/${res.parcel.id}/attach`), warehouse.token).send({ version: 2, returnRequestId: r.id });
    expect([again.status, again.body.code]).toEqual([409, 'parcel_resolved']);
  });

  it('bỏ qua kiện: dismissed kèm lý do, vẫn có trong danh sách theo trạng thái', async () => {
    const res = ReceiveResult.parse((await receive({ code: `UNK-${randomUUID().slice(0, 8)}` })).body);
    if (res.kind !== 'unmatched') throw new Error('phải là kiện không khớp');
    const path = `/api/v1/returns/unmatched/${res.parcel.id}/dismiss`;
    expect((await auth(app().post(path), warehouse.token).send({ version: 1, reason: '' })).body.errors).toEqual({ reason: expect.any(String) });
    const dismissed = UnmatchedParcel.parse((await auth(app().post(path), warehouse.token).send({ version: 1, reason: 'Không phải hàng của shop' })).body);
    expect(dismissed).toMatchObject({ status: 'dismissed', resolution: 'Không phải hàng của shop', resolvedBy: { id: warehouse.accountId } });
    const list = UnmatchedList.parse((await auth(app().get('/api/v1/returns/unmatched?status=dismissed'))).body);
    expect(list.map((p) => p.id)).toContain(res.parcel.id);
  });
});
