// Điều phối kết quả cổng đã kiểm chữ ký (plan chuẩn bị A11): ghi giao dịch (`payment.recordGatewayTransaction`) →
// `payment.markPaid` → phiếu thu, hoặc khoản thu chưa khớp → outbox `payment.succeeded`, một giao dịch.
// src/wiring.ts tiêm hàm này vào payment qua `ctx.onVerifiedPayment`. #27 viết thân ở file này.
import { notImplemented } from '../../../shared/errors/app-error.ts';
import type { VerifiedPaymentHandler } from '../../payment/index.ts';

export const handleVerifiedPayment: VerifiedPaymentHandler = async () => {
  throw notImplemented('handleVerifiedPayment', '#27');
};
