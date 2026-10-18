// Webhook và tra cứu quá hạn (plan chuẩn bị A11, K4): payment kiểm chữ ký rồi giao kết quả cho handler của finance.
// Chiều import là finance → payment, nên payment không import finance mà nhận handler qua `ctx` do src/wiring.ts dựng.
// #27 viết thân ở file này.
import type { Decimal } from 'decimal.js';
import { AppError } from '../../../shared/errors/app-error.ts';
import { logger } from '../../../shared/logger.ts';
import { findTransactionId, insertTransactionIfNew, insertWebhookEventIfNew } from '../repository/transactions.ts';
import type { ModuleContext } from '../../../shared/module.ts';
import type { txnSource, txnStatus } from '../repository/schema.ts';
import type { Gateway } from './boundary.ts';

type TxnStatus = (typeof txnStatus.enumValues)[number];

/** Kết quả cổng đã kiểm chữ ký, của đúng một công ty (D16). */
export interface VerifiedGatewayPayment {
  companyId: string;
  gateway: Gateway;
  source: (typeof txnSource.enumValues)[number];
  /** Khoá chống trùng của cổng (12.4). */
  eventKey: string;
  gatewayTxnId: string;
  paymentCode: string | null;
  paymentLinkId: string | null;
  orderId: string | null;
  amount: Decimal;
  succeeded: boolean;
  fee: Decimal | null;
  occurredAt: Date;
  /** Payload của cổng, đã bỏ chữ ký. */
  rawPayload: unknown;
}

/** Handler chạy trong `withCompany` mà payment mở; `outcome` quyết định phản hồi cho cổng. */
export type VerifiedPaymentHandler = (
  payment: VerifiedGatewayPayment,
) => Promise<{ outcome: 'recorded' | 'duplicate' | 'unmatched' | 'failed' }>;

/**
 * Phiếu thu, khoản thu chưa khớp của các giao dịch cổng (`receipt`, `unmatchedReceiptId` của `PaymentTransaction`,
 * §12.8). Bảng nằm ở finance, payment không import finance: `src/wiring.ts` tiêm `finance.getTransactionRefs` (A21).
 */
export type TransactionRefsLookup = (
  transactionIds: readonly string[],
) => Promise<Map<string, { receipt: { id: string; number: string } | null; unmatchedReceiptId: string | null }>>;

/** `ctx` mà router (và việc nền) của payment nhận. */
export interface PaymentContext extends ModuleContext {
  readonly onVerifiedPayment?: VerifiedPaymentHandler;
  readonly financeRefsOf?: TransactionRefsLookup;
}

/** Handler đã tiêm; chưa tiêm là lỗi lắp ráp, báo 500 rõ ràng thay vì nuốt webhook. */
export function verifiedPaymentHandlerOf(ctx: PaymentContext): VerifiedPaymentHandler {
  if (!ctx.onVerifiedPayment) {
    throw new AppError(500, 'internal_error', 'Chưa nối xử lý thanh toán của finance (src/wiring.ts)');
  }
  return ctx.onVerifiedPayment;
}

/**
 * Ghi `webhook_events` (chống trùng theo `event_key`) rồi `payment_transactions` (chống trùng theo `(gateway,
 * gateway_txn_id)` toàn hệ thống), theo thứ tự §12.4 bước 4; finance gọi trong handler, trong `withCompany`.
 * Trùng ở bước nào cũng là `duplicate` (cổng gửi lại), không ghi gì thêm.
 */
export async function recordGatewayTransaction(
  payment: VerifiedGatewayPayment,
  status: Exclude<TxnStatus, 'pending'>,
): Promise<{ transactionId: string; duplicate: boolean }> {
  const duplicate = async () => {
    const transactionId = await findTransactionId(payment.gateway, payment.gatewayTxnId);
    // Unique (gateway, gateway_txn_id) là toàn hệ thống: dòng trùng không thấy dưới RLS là của công ty khác (khoá cổng
    // của công ty khác ký được cùng mã giao dịch). Không báo "đã xử lý" cho cổng, vì tiền của công ty này sẽ mất dấu:
    // ném lỗi để cổng gửi lại và log để người vận hành xem (review diff PR2 #27).
    if (!transactionId) {
      logger.error({ gateway: payment.gateway, gatewayTxnId: payment.gatewayTxnId }, 'mã giao dịch cổng trùng với công ty khác');
      throw new Error('Mã giao dịch cổng đã thuộc công ty khác');
    }
    return { transactionId, duplicate: true };
  };
  const fresh = await insertWebhookEventIfNew({
    companyId: payment.companyId,
    gateway: payment.gateway,
    eventKey: payment.eventKey,
    payload: payment.rawPayload ?? {},
  });
  if (!fresh) return duplicate();
  const transactionId = await insertTransactionIfNew({
    companyId: payment.companyId,
    paymentLinkId: payment.paymentLinkId,
    orderId: payment.orderId,
    gateway: payment.gateway,
    gatewayTxnId: payment.gatewayTxnId,
    amount: payment.amount.toFixed(2),
    fee: payment.fee?.toFixed(2) ?? null,
    source: payment.source,
    status,
    rawPayload: payment.rawPayload ?? null,
    occurredAt: payment.occurredAt,
  });
  return transactionId ? { transactionId, duplicate: false } : duplicate();
}
