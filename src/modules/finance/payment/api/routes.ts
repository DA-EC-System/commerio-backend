import { Router } from 'express';
import type { PaymentContext } from '../service/webhook-handler.ts';
import { webhookRouter } from './webhooks.ts';

/**
 * Route của module `payment`, gắn tại /api/v1/payment. Chỉ còn webhook của cổng: sau khi kiểm chữ ký giao cho
 * `verifiedPaymentHandlerOf(ctx)` (handler của finance, A11). `gateways`, `orders`, `transactions`, `dev/simulate` đã
 * gỡ ở #235 (cổng thanh toán ngoài MVP), gọi vào trả 404.
 */
export function paymentRouter(ctx: PaymentContext): Router {
  const router = Router();
  router.use('/webhooks', webhookRouter(ctx));
  return router;
}
