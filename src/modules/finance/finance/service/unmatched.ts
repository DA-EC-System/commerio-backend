// Khoản thu chưa khớp (UC-PF-07, gộp vào #27 theo T22): Documents/21 §12.5 ba dòng `unmatched-receipts`, §12.8
// `UnmatchedReceipt`, §12.2; plan #27 AC-34…AC-36. Khoản do webhook sinh (PR2): lệch tiền, không mã, đơn đã huỷ.
// Gán vào đơn chưa thu đủ tiền (phiếu thu `unmatched_assignment`, đơn `paid`), hoặc hoàn lại (phiếu chi `unmatched_refund`).
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { recordAudit } from '../../../core/index.ts';
import { getOrderPayments, getOrderPaymentView, getPaymentTransactions } from '../../payment/index.ts';
import { getOrderForPayment } from '../../../order/index.ts';
import {
  findReceiptsOfUnmatched,
  findUnmatched,
  findUnmatchedList,
  type UnmatchedFilter,
  type UnmatchedRow,
} from '../repository/receipts.ts';
import { findRefundVouchersOfUnmatched, insertVoucher, setUnmatchedStatus } from '../repository/vouchers.ts';
import { receiptViews } from './documents.ts';
import { nextDocNumber } from './doc-numbers.ts';
import { postOrderReceipt } from './order-receipt.ts';
import { type Caller, postLocked, view as voucherView } from './payment-vouchers.ts';
import { isUuid, money, notFound, orderRef, ordersOf, type Page, paginate } from './views.ts';

async function views(rows: UnmatchedRow[]) {
  const ids = rows.map((r) => r.id);
  const txns = await getPaymentTransactions(rows.flatMap((r) => (r.paymentTransactionId ? [r.paymentTransactionId] : [])));
  const txnOf = (r: UnmatchedRow) => (r.paymentTransactionId ? txns.get(r.paymentTransactionId) : undefined);
  const orders = await ordersOf(rows.flatMap((r) => [r.assignedOrderId, txnOf(r)?.orderId ?? null]));
  const receiptOf = new Map((await findReceiptsOfUnmatched(ids)).map((r) => [r.unmatchedId, { id: r.id, number: r.number }]));
  const voucherOf = new Map((await findRefundVouchersOfUnmatched(ids)).map((v) => [v.unmatchedId, { id: v.id, number: v.number }]));
  return rows.map((r) => ({
    id: r.id,
    receivedAt: r.receivedAt.toISOString(),
    amount: money(r.amount),
    transferContent: r.transferContent,
    gateway: txnOf(r)?.gateway ?? null,
    reason: r.reason,
    status: r.status,
    // Đơn mà mã thanh toán trong tiền về trỏ tới (lệch tiền, đơn huỷ); không mã thì `null`.
    suggestedOrder: orderRef(orders, txnOf(r)?.orderId ?? null),
    assignedOrder: orderRef(orders, r.assignedOrderId),
    receipt: receiptOf.get(r.id) ?? null,
    voucher: voucherOf.get(r.id) ?? null,
    version: r.version,
  }));
}

export function listUnmatched(companyId: string, q: UnmatchedFilter & Page) {
  return withCompany(companyId, async () => {
    const rows = await findUnmatchedList(q);
    const { slice, ...pageInfo } = paginate(rows, q, (r) => [r.transferContent]);
    return { items: await views(slice), ...pageInfo };
  });
}

/** Khoá khoản rồi kiểm: không thấy → 404; `version` lệch → 409 kèm `current`; không còn `open` → 409 `already_processed`. */
async function lockOpen(id: string, version: number): Promise<UnmatchedRow> {
  const u = isUuid(id) ? await findUnmatched(id, 'update') : undefined;
  if (!u) throw notFound('khoản thu chưa khớp');
  const current = async () => (await views([u]))[0];
  if (u.version !== version) {
    throw new AppError(409, 'version_conflict', 'Khoản thu vừa được người khác xử lý', { current: await current() });
  }
  if (u.status !== 'open') {
    throw new AppError(409, 'already_processed', 'Khoản thu đã được gán hoặc hoàn', { current: await current() });
  }
  return u;
}

/**
 * Gán khoản vào đơn trả trước chưa thu, đủ tiền (§12.5): khoá khoản, khoá dòng đơn (A4) → `payment.markPaid` → phiếu thu
 * `unmatched_assignment` → khoản `assigned` → nhật ký, sự kiện `payment.succeeded` (FE#9 đổi trạng thái đơn qua SSE).
 */
export function assignUnmatched(caller: Caller, id: string, input: { orderId: string; version: number }) {
  return withCompany(caller.companyId, async () => {
    const u = await lockOpen(id, input.version);
    const order = isUuid(input.orderId) ? await getOrderForPayment(input.orderId, { lock: 'share' }) : null;
    if (!order) throw notFound('đơn hàng');
    const state = (await getOrderPayments([order.id])).get(order.id);
    const status = state?.status ?? (order.paymentMethod === 'prepaid' ? 'unpaid' : null);
    if (order.status === 'cancelled' || status !== 'unpaid') {
      throw new AppError(409, 'payment_state_changed', 'Đơn không ở trạng thái chưa thu hoặc đã huỷ', {
        current: order.paymentMethod ? await getOrderPaymentView(caller.companyId, order.id) : null,
      });
    }
    if (!order.total.equals(u.amount)) {
      throw new AppError(422, 'amount_mismatch', 'Số tiền khoản thu khác tổng đơn', {
        errors: { orderId: `Tổng đơn ${order.total.toNumber()} đ khác số tiền khoản thu ${money(u.amount)} đ` },
      });
    }
    const txn = u.paymentTransactionId ? (await getPaymentTransactions([u.paymentTransactionId])).get(u.paymentTransactionId) : undefined;
    let receipt;
    try {
      receipt = await postOrderReceipt({
        companyId: caller.companyId,
        orderId: order.id,
        source: 'unmatched_assignment',
        amount: u.amount,
        gateway: txn?.gateway ?? null,
        paymentTransactionId: u.paymentTransactionId,
        paymentLinkId: null,
        unmatchedReceiptId: u.id,
      });
    } catch (err) {
      // Đơn vừa được trả song song (webhook, người khác gán khoản khác): `current` theo §12.9 là `OrderPayment`.
      if (!(err instanceof AppError && err.code === 'payment_state_changed')) throw err;
      throw new AppError(409, err.code, err.message, { current: await getOrderPaymentView(caller.companyId, order.id) });
    }
    await setUnmatchedStatus(u.id, 'assigned', order.id);
    await recordAudit({
      companyId: caller.companyId,
      actorId: caller.accountId,
      action: 'update',
      entityType: 'finance.unmatched_receipts',
      entityId: u.id,
      before: { status: 'open' },
      after: { status: 'assigned', orderId: order.id, receipt: receipt.number },
    });
    const orders = new Map([[order.id, { ...order, customerName: order.customer?.name ?? null, customerPhone: order.customer?.phone ?? null }]]);
    return {
      unmatchedReceipt: (await views([{ ...u, status: 'assigned', assignedOrderId: order.id, version: u.version + 1 }]))[0],
      receipt: (await receiptViews([receipt], orders))[0],
    };
  });
}

/** Hoàn khoản cho người chuyển (§12.5): phiếu chi `unmatched_refund` = số tiền khoản, ghi sổ ngay; khoản `refunded`. */
export function refundUnmatched(caller: Caller, id: string, input: { paidOn: string; note: string; version: number }) {
  return withCompany(caller.companyId, async () => {
    const u = await lockOpen(id, input.version);
    const draft = await insertVoucher({
      companyId: caller.companyId,
      number: await nextDocNumber('payment_voucher'),
      purpose: 'unmatched_refund',
      unmatchedReceiptId: u.id,
      amount: u.amount,
      paidOn: input.paidOn,
      note: input.note,
      createdBy: caller.accountId,
    });
    return voucherView(await postLocked(caller, draft));
  });
}
