// Điều phối kết quả cổng đã kiểm chữ ký (Documents/21 §12.4 bước 4; plan chuẩn bị A11, plan #27 A4): khoá dòng đơn →
// ghi giao dịch (`payment.recordGatewayTransaction`, chống trùng) → `payment.markPaid` + phiếu thu, hoặc khoản thu chưa
// khớp → outbox, một giao dịch. src/wiring.ts tiêm hàm này vào payment qua `ctx.onVerifiedPayment`.
import {
  getOrderPayments,
  recordGatewayTransaction,
  type VerifiedGatewayPayment,
  type VerifiedPaymentHandler,
} from '../../payment/index.ts';
import { getOrderForPayment } from '../../sales/index.ts';
import { inTransaction, requireCompanyId } from '../../../shared/db/client.ts';
import { AppError } from '../../../shared/errors/app-error.ts';
import { decidePayment } from '../domain/payment-outcome.ts';
import { insertUnmatchedReceipt } from '../repository/receipts.ts';
import { postOrderReceipt } from './order-receipt.ts';

/** Nội dung chuyển khoản (chỉ SePay có) cho khoản thu chưa khớp, để kế toán dò. */
const transferContentOf = (raw: unknown) => {
  const content = (raw as { content?: unknown } | null)?.content;
  return typeof content === 'string' ? content : null;
};

type LockedOrder = Awaited<ReturnType<typeof getOrderForPayment>>;

export const handleVerifiedPayment: VerifiedPaymentHandler = async (payment) => {
  // Savepoint và lần chạy lại dưới đây cần giao dịch `withCompany` của bên gọi (RLS, cùng một giao dịch).
  requireCompanyId('handleVerifiedPayment');
  // Khoá dòng đơn trước (FOR SHARE), rồi mới tới `order_payments` trong markPaid: cùng thứ tự với tạo mã, huỷ đơn (A4).
  const order = payment.orderId ? await getOrderForPayment(payment.orderId, { lock: 'share' }) : null;
  try {
    // Savepoint: lần thử thua thì lùi cả giao dịch cổng `succeeded` vừa ghi.
    return await inTransaction((tx) => tx.transaction(() => settle(payment, order)));
  } catch (err) {
    // Khoản khác cùng trả đơn này vừa commit trước (#63 B21): xử lý lại, đơn đã `paid` → khoản thu chưa khớp,
    // không trả lỗi cho cổng (cổng có thể không gửi lại, tiền sẽ mất dấu).
    if (!(err instanceof AppError && err.code === 'payment_state_changed')) throw err;
    return settle(payment, order);
  }
};

async function settle(payment: VerifiedGatewayPayment, order: LockedOrder): ReturnType<VerifiedPaymentHandler> {
  const state = order ? (await getOrderPayments([order.id])).get(order.id) : undefined;
  const decision = decidePayment({
    succeeded: payment.succeeded,
    amount: payment.amount,
    order: order && {
      status: order.status,
      total: order.total,
      // Đơn chưa xác nhận chưa có dòng `order_payments`: trả trước thì coi là chưa thu (A8).
      paymentStatus: state?.status ?? (order.paymentMethod === 'cod' ? 'cod_pending' : 'unpaid'),
    },
  });

  const status = ({ failed: 'failed', receipt: 'succeeded', unmatched: 'needs_review' } as const)[decision.kind];
  const { transactionId, duplicate } = await recordGatewayTransaction(payment, status);
  if (duplicate) return { outcome: 'duplicate' };
  if (decision.kind === 'failed') return { outcome: 'failed' };

  if (decision.kind === 'unmatched') {
    await insertUnmatchedReceipt({
      companyId: payment.companyId,
      paymentTransactionId: transactionId,
      amount: payment.amount.toFixed(2),
      transferContent: transferContentOf(payment.rawPayload),
      reason: decision.reason,
      receivedAt: payment.occurredAt,
    });
    return { outcome: 'unmatched' };
  }

  await postOrderReceipt({
    companyId: payment.companyId,
    orderId: order!.id,
    source: 'gateway',
    amount: payment.amount,
    gateway: payment.gateway,
    paymentTransactionId: transactionId,
    paymentLinkId: payment.paymentLinkId,
  });
  return { outcome: 'recorded' };
};
