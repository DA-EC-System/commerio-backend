// Webhook và tra cứu quá hạn (plan chuẩn bị A11, K4): payment kiểm chữ ký rồi giao kết quả cho handler của finance.
// Chiều import là finance → payment, nên payment không import finance mà nhận handler qua `ctx` do src/wiring.ts dựng.
// #27 viết thân ở file này.
import type { Decimal } from 'decimal.js';
import { AppError, notImplemented } from '../../../shared/errors/app-error.ts';
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

/** `ctx` mà router (và việc nền) của payment nhận. */
export interface PaymentContext extends ModuleContext {
  readonly onVerifiedPayment?: VerifiedPaymentHandler;
}

/** Handler đã tiêm; chưa tiêm là lỗi lắp ráp, báo 500 rõ ràng thay vì nuốt webhook. */
export function verifiedPaymentHandlerOf(ctx: PaymentContext): VerifiedPaymentHandler {
  if (!ctx.onVerifiedPayment) {
    throw new AppError(500, 'internal_error', 'Chưa nối xử lý thanh toán của finance (src/wiring.ts)');
  }
  return ctx.onVerifiedPayment;
}

/** Ghi `webhook_events` (chống trùng theo `event_key`) và `payment_transactions`; finance gọi trong handler. */
export async function recordGatewayTransaction(
  _payment: VerifiedGatewayPayment,
  _status: Exclude<TxnStatus, 'pending'>,
): Promise<{ transactionId: string; duplicate: boolean }> {
  throw notImplemented('recordGatewayTransaction', '#27');
}
