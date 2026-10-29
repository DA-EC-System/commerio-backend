// API công khai của module lớn `finance` (Tài chính: thanh toán qua cổng, chứng từ, đối soát).
// Module lớn khác chỉ được import từ file này; module con trong cùng module lớn gọi nhau qua index.ts của module con.
import { type ModuleContext, type ModuleDefinition, withContext } from '../../shared/module.ts';
import { financeModule, getTransactionRefs, handleVerifiedPayment } from './finance/index.ts';
import { type PaymentContext, paymentModule } from './payment/index.ts';

export * from './payment/index.ts';
export * from './finance/index.ts';

/**
 * `ctx` của payment kèm hàm của finance. finance import payment (markPaid, giao dịch cổng), nên payment không import
 * lại finance mà nhận qua đây: webhook giao cho finance sinh phiếu thu trong cùng giao dịch (A11), phiếu thu và khoản
 * thu chưa khớp của giao dịch cổng (#27 A21).
 */
export function paymentContext<C extends ModuleContext>(ctx: C): C & Required<Pick<PaymentContext, 'onVerifiedPayment' | 'financeRefsOf'>> {
  return { ...ctx, onVerifiedPayment: handleVerifiedPayment, financeRefsOf: getTransactionRefs };
}

/** Mỗi module con giữ tên, schema và đường dẫn /api/v1/<tên> riêng. */
export const financeModules: readonly ModuleDefinition[] = [withContext(paymentModule, paymentContext), financeModule];
