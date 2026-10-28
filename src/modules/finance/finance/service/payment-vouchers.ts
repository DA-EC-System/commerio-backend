// Phiếu chi (UC-PF-05) và hoàn tiền (UC-PF-06): Documents/21 §12.5, T19, T20, C3, V8; plan #27 AC-28…AC-33.
// Phiếu chi trỏ đúng một chứng từ gốc theo `purpose`; số tiền bằng số phải chi (không chi một phần). Ghi sổ đổi chứng từ
// gốc cùng giao dịch: đơn → `refunded` (payment.markRefunded), khoản thu chưa khớp → `refunded`.
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { recordAudit } from '../../../core/index.ts';
import {
  getOrderPayments,
  getOrderPaymentView,
  getPaymentTransactions,
  listOrderPayments,
  markRefunded,
} from '../../payment/index.ts';
import { publishEvent } from '../../../core/index.ts';
import { getOrderForPayment } from '../../../order/index.ts';
import { findReceipts, findUnmatched } from '../repository/receipts.ts';
import {
  deleteVoucher,
  findPostedVoucherOf,
  findRefundVouchersOfOrders,
  findVoucher,
  findVouchers,
  insertVoucher,
  setUnmatchedStatus,
  updateVoucher,
  type VoucherFilter,
  type VoucherRow,
} from '../repository/vouchers.ts';
import { nextDocNumber } from './doc-numbers.ts';
import { isUuid, money, notFound, type Orders, orderRef, orderRefWithPhone, ordersOf, type Page, paginate, userRef } from './views.ts';

export interface Caller {
  companyId: string;
  accountId: string;
}

export interface VoucherInput {
  purpose: VoucherRow['purpose'];
  orderId?: string;
  unmatchedReceiptId?: string;
  amount: number;
  paidOn: string;
  note: string;
}

const ENTITY = 'finance.payment_vouchers';
const fieldError = (field: string, message: string) =>
  new AppError(422, 'validation_failed', 'Dữ liệu gửi lên không hợp lệ', { errors: { [field]: message } });

/** Nhớ tạm trong một lượt danh sách: tên người, khoản thu chưa khớp đọc một lần mỗi id. */
const newCache = () => ({ names: new Map<string, ReturnType<typeof userRef>>(), unmatched: new Map<string, ReturnType<typeof findUnmatched>>() });

export async function view(v: VoucherRow, orders?: Orders, cache = newCache()) {
  const o = orders ?? (await ordersOf([v.orderId]));
  const uid = v.unmatchedReceiptId;
  if (uid && !cache.unmatched.has(uid)) cache.unmatched.set(uid, findUnmatched(uid));
  const u = uid ? await cache.unmatched.get(uid) : undefined;
  return {
    id: v.id,
    number: v.number,
    purpose: v.purpose,
    order: orderRef(o, v.orderId),
    unmatchedReceipt: u ? { id: u.id, amount: money(u.amount), transferContent: u.transferContent } : null,
    supplierInvoiceId: v.supplierInvoiceId,
    amount: money(v.amount),
    paidOn: v.paidOn,
    note: v.note ?? '',
    status: v.status,
    createdBy: await userRef(v.createdBy, cache.names),
    createdAt: v.createdAt.toISOString(),
    postedBy: await userRef(v.postedBy, cache.names),
    postedAt: v.postedAt?.toISOString() ?? null,
    // Chứng từ đảo (UC-PF-09) chưa có issue.
    reversalOf: null,
    reversedBy: null,
    reversalReason: v.reversalReason,
    version: v.version,
  };
}

/** Số phải chi theo chứng từ gốc (T19); chứng từ gốc không còn cần chi → 422 theo ô. */
async function amountDue(purpose: VoucherRow['purpose'], source: { orderId?: string | null; unmatchedReceiptId?: string | null }) {
  if (purpose === 'supplier_payment') throw fieldError('purpose', 'Chi cho nhà cung cấp chưa làm (UC-PF-08)');
  if (purpose === 'customer_refund') {
    if (source.unmatchedReceiptId) throw fieldError('unmatchedReceiptId', 'Hoàn tiền đơn không trỏ khoản thu chưa khớp');
    if (!source.orderId) throw fieldError('orderId', 'Chọn đơn cần hoàn tiền');
    const state = isUuid(source.orderId) ? (await getOrderPayments([source.orderId])).get(source.orderId) : undefined;
    if (state?.refundStatus !== 'pending_refund') throw fieldError('orderId', 'Đơn không có hoặc không còn chờ hoàn tiền');
    return state.amount;
  }
  if (source.orderId) throw fieldError('orderId', 'Hoàn khoản thu chưa khớp không trỏ đơn');
  if (!source.unmatchedReceiptId) throw fieldError('unmatchedReceiptId', 'Chọn khoản thu chưa khớp cần hoàn');
  const u = isUuid(source.unmatchedReceiptId) ? await findUnmatched(source.unmatchedReceiptId) : undefined;
  if (u?.status !== 'open') throw fieldError('unmatchedReceiptId', 'Khoản thu không có hoặc đã xử lý');
  return money(u.amount);
}

async function assertAmount(v: { purpose: VoucherRow['purpose']; orderId?: string | null; unmatchedReceiptId?: string | null }, amount: number) {
  const due = await amountDue(v.purpose, v);
  if (Number(due) !== amount) throw fieldError('amount', `Số tiền phải bằng số phải chi (${Number(due)} đ)`);
}

export function createVoucher(caller: Caller, input: VoucherInput) {
  return withCompany(caller.companyId, async () => {
    await assertAmount(input, input.amount);
    const v = await insertVoucher({
      companyId: caller.companyId,
      number: await nextDocNumber('payment_voucher'),
      purpose: input.purpose,
      orderId: input.orderId ?? null,
      unmatchedReceiptId: input.unmatchedReceiptId ?? null,
      amount: input.amount.toFixed(2),
      paidOn: input.paidOn,
      note: input.note,
      createdBy: caller.accountId,
    });
    await recordAudit({
      companyId: caller.companyId,
      actorId: caller.accountId,
      action: 'create',
      entityType: ENTITY,
      entityId: v.id,
      after: { number: v.number, purpose: v.purpose, amount: input.amount },
    });
    return view(v);
  });
}

/** Khoá phiếu rồi kiểm theo thứ tự: không thấy → 404; `version` lệch → 409 kèm `current`; không nháp → 409 `not_draft`. */
async function lockDraft(id: string, version: number): Promise<VoucherRow> {
  const v = isUuid(id) ? await findVoucher(id, 'update') : undefined;
  if (!v) throw notFound('phiếu chi');
  if (v.version !== version) {
    throw new AppError(409, 'version_conflict', 'Phiếu chi vừa được người khác sửa hoặc ghi sổ', { current: await view(v) });
  }
  if (v.status !== 'draft') throw new AppError(409, 'not_draft', 'Chỉ sửa, xoá, ghi sổ được phiếu chi nháp');
  return v;
}

export function updateDraft(caller: Caller, id: string, input: { amount: number; paidOn: string; note: string; version: number }) {
  return withCompany(caller.companyId, async () => {
    const v = await lockDraft(id, input.version);
    await assertAmount(v, input.amount);
    const updated = await updateVoucher(v.id, { amount: input.amount.toFixed(2), paidOn: input.paidOn, note: input.note });
    await recordAudit({
      companyId: caller.companyId,
      actorId: caller.accountId,
      action: 'update',
      entityType: ENTITY,
      entityId: v.id,
      before: { amount: money(v.amount), paidOn: v.paidOn, note: v.note },
      after: { amount: input.amount, paidOn: input.paidOn, note: input.note },
    });
    return view(updated);
  });
}

export function deleteDraft(caller: Caller, id: string, version: number) {
  return withCompany(caller.companyId, async () => {
    const v = await lockDraft(id, version);
    await deleteVoucher(v.id);
    await recordAudit({
      companyId: caller.companyId,
      actorId: caller.accountId,
      action: 'delete',
      entityType: ENTITY,
      entityId: v.id,
      before: { number: v.number, purpose: v.purpose, amount: money(v.amount) },
    });
  });
}

const alreadyProcessed = (number: string | undefined) =>
  new AppError(409, 'already_processed', `Chứng từ gốc đã có phiếu chi ghi sổ${number ? ` ${number}` : ''}`);

/**
 * Ghi sổ phiếu đã khoá và đổi chứng từ gốc cùng giao dịch (T20): đơn → `refunded` (khoá dòng đơn trước, A4), khoản thu
 * chưa khớp → `refunded`. Chứng từ gốc đã xử lý → 409 `already_processed` nêu số phiếu đã có; đơn không chờ hoàn → 409
 * `payment_state_changed` kèm `current: OrderPayment`.
 */
export async function postLocked(caller: Caller, v: VoucherRow): Promise<VoucherRow> {
  if (v.purpose === 'customer_refund' && v.orderId) {
    if (!(await getOrderForPayment(v.orderId, { lock: 'share' }))) throw notFound('đơn hàng');
    try {
      await markRefunded(v.orderId);
    } catch (err) {
      if (!(err instanceof AppError && err.code === 'payment_state_changed')) throw err;
      const done = await findPostedVoucherOf({ orderId: v.orderId });
      if (done) throw alreadyProcessed(done.number);
      throw new AppError(409, 'payment_state_changed', err.message, {
        current: await getOrderPaymentView(caller.companyId, v.orderId),
      });
    }
  } else if (v.purpose === 'unmatched_refund' && v.unmatchedReceiptId) {
    const u = await findUnmatched(v.unmatchedReceiptId, 'update');
    if (u?.status !== 'open') throw alreadyProcessed((await findPostedVoucherOf({ unmatchedReceiptId: v.unmatchedReceiptId }))?.number);
    await setUnmatchedStatus(u.id, 'refunded');
  }
  const posted = await updateVoucher(v.id, { status: 'posted', postedBy: caller.accountId, postedAt: new Date() });
  await recordAudit({
    companyId: caller.companyId,
    actorId: caller.accountId,
    action: 'update',
    entityType: ENTITY,
    entityId: v.id,
    before: { status: 'draft' },
    after: { status: 'posted', number: v.number, amount: money(v.amount) },
  });
  await publishEvent({
    type: 'finance.voucher_posted',
    aggregateId: v.id,
    payload: { voucherId: v.id, purpose: v.purpose, orderId: v.orderId, amount: posted.amount, paidOn: posted.paidOn, reversalOf: null },
  });
  return posted;
}

export function postVoucher(caller: Caller, id: string, version: number) {
  return withCompany(caller.companyId, async () => view(await postLocked(caller, await lockDraft(id, version))));
}

/** Hoàn tiền một bước (T20): lập và ghi sổ phiếu chi `customer_refund` = số đã thu. */
export function refundOrder(caller: Caller, input: { orderId: string; paidOn: string; note: string }) {
  return withCompany(caller.companyId, async () => {
    const state = isUuid(input.orderId) ? (await getOrderPayments([input.orderId])).get(input.orderId) : undefined;
    if (!state) throw notFound('đơn hàng');
    if (state.refundStatus === 'refunded') throw alreadyProcessed((await findPostedVoucherOf({ orderId: input.orderId }))?.number);
    if (state.refundStatus !== 'pending_refund') {
      throw new AppError(409, 'payment_state_changed', 'Đơn không ở trạng thái chờ hoàn tiền', {
        current: await getOrderPaymentView(caller.companyId, input.orderId),
      });
    }
    const draft = await insertVoucher({
      companyId: caller.companyId,
      number: await nextDocNumber('payment_voucher'),
      purpose: 'customer_refund',
      orderId: input.orderId,
      amount: state.amount.toFixed(2),
      paidOn: input.paidOn,
      note: input.note,
      createdBy: caller.accountId,
    });
    return view(await postLocked(caller, draft));
  });
}

export function getVoucher(companyId: string, id: string) {
  return withCompany(companyId, async () => {
    const v = isUuid(id) ? await findVoucher(id) : undefined;
    if (!v) throw notFound('phiếu chi');
    return view(v);
  });
}

export function listVouchers(companyId: string, q: VoucherFilter & Page) {
  return withCompany(companyId, async () => {
    const rows = await findVouchers(q);
    const orders = await ordersOf(rows.map((r) => r.orderId));
    const { slice, ...pageInfo } = paginate(rows, q, (r) => [r.number, r.note, orders.get(r.orderId ?? '')?.code]);
    const cache = newCache();
    const items = [];
    for (const v of slice) items.push(await view(v, orders, cache));
    return { items, ...pageInfo };
  });
}

/** Tab Cần hoàn tiền (§12.8 `RefundItem`); `cancelledAt` = lúc chuyển chờ hoàn, `null` khi đã hoàn (A11). */
export function listRefunds(companyId: string, q: Page & { status: 'pending_refund' | 'refunded' }) {
  return withCompany(companyId, async () => {
    const rows = await listOrderPayments({ refundStatus: q.status });
    const orders = await ordersOf(rows.map((r) => r.orderId));
    const { slice, ...pageInfo } = paginate(rows, q, (r) => [orders.get(r.orderId)?.code, orders.get(r.orderId)?.customerName]);
    const ids = slice.map((r) => r.orderId);
    const receipts = await findReceipts({ status: 'posted', orderIds: ids });
    const receiptOf = new Map(receipts.map((r) => [r.orderId, r]));
    const txns = await getPaymentTransactions(receipts.flatMap((r) => (r.paymentTransactionId ? [r.paymentTransactionId] : [])));
    const voucherOf = new Map((await findRefundVouchersOfOrders(ids)).map((v) => [v.orderId, { id: v.id, number: v.number }]));
    return {
      items: slice.map((r) => {
        const receipt = receiptOf.get(r.orderId);
        const gateway = receipt?.paymentTransactionId ? txns.get(receipt.paymentTransactionId)?.gateway : undefined;
        return {
          order: orderRefWithPhone(orders, r.orderId),
          paidAmount: r.amount.toNumber(),
          paidVia: receipt?.source === 'unmatched_assignment' ? 'unmatched_assignment' : (gateway ?? null),
          paidAt: r.paidAt?.toISOString() ?? null,
          cancelledAt: r.refundStatus === 'pending_refund' ? r.updatedAt.toISOString() : null,
          refundStatus: r.refundStatus,
          voucher: voucherOf.get(r.orderId) ?? null,
        };
      }),
      ...pageInfo,
    };
  });
}
