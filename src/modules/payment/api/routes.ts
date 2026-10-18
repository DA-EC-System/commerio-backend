import { Router } from 'express';
import type { PaymentContext } from '../service/webhook-handler.ts';

/**
 * Route của module `payment`, gắn tại /api/v1/payment. Kiểm quyền bằng `ctx.authorize(...)`; webhook sau khi kiểm
 * chữ ký giao cho `verifiedPaymentHandlerOf(ctx)` (handler của finance, A11).
 */
export function paymentRouter(_ctx: PaymentContext): Router {
  return Router();
}
