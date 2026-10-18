// Điều phối kết quả cổng đã kiểm chữ ký (Documents/21 §12.4 bước 4; plan chuẩn bị A11, plan #27 A4): khoá dòng đơn →
// ghi giao dịch (`payment.recordGatewayTransaction`, chống trùng) → `payment.markPaid` + phiếu thu, hoặc khoản thu chưa
// khớp → outbox, một giao dịch. src/wiring.ts tiêm hàm này vào payment qua `ctx.onVerifiedPayment`.
import { getOrderPayments, markPaid, recordGatewayTransaction, type VerifiedPaymentHandler } from '../../payment/index.ts';
import { publishEvent } from '../../platform/index.ts';
import { getOrderForPayment } from '../../sales/index.ts';
import { decidePayment } from '../domain/payment-outcome.ts';
import { insertReceipt, insertUnmatchedReceipt } from '../repository/receipts.ts';
import { nextDocNumber } from './doc-numbers.ts';

/** Nội dung chuyển khoản (chỉ SePay có) cho khoản thu chưa khớp, để kế toán dò. */
const transferContentOf = (raw: unknown) => {
  const content = (raw as { content?: unknown } | null)?.content;
  return typeof content === 'string' ? content : null;
};

export const handleVerifiedPayment: VerifiedPaymentHandler = async (payment) => {
  // Khoá dòng đơn trước (FOR SHARE), rồi mới tới `order_payments` trong markPaid: cùng thứ tự với tạo mã, huỷ đơn (A4).
  const order = payment.orderId ? await getOrderForPayment(payment.orderId, { lock: 'share' }) : null;
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

  const orderId = order!.id;
  await markPaid(orderId, { paymentTransactionId: transactionId, paymentLinkId: payment.paymentLinkId });
  const receipt = await insertReceipt({
    companyId: payment.companyId,
    number: await nextDocNumber('receipt'),
    orderId,
    source: 'gateway',
    paymentTransactionId: transactionId,
    amount: payment.amount.toFixed(2),
  });
  await publishEvent({
    type: 'payment.succeeded',
    aggregateId: orderId,
    payload: { orderId, paymentTransactionId: transactionId, gateway: payment.gateway, amount: receipt.amount },
  });
  await publishEvent({
    type: 'finance.receipt_posted',
    aggregateId: receipt.id,
    payload: {
      receiptId: receipt.id,
      orderId,
      amount: receipt.amount,
      source: 'gateway',
      postedAt: receipt.postedAt.toISOString(),
      reversalOf: null,
    },
  });
  return { outcome: 'recorded' };
};
