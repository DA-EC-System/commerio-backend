import { type Request, type Response, Router } from 'express';
import type { CallbackInput } from '../service/gateways/index.ts';
import type { PaymentContext } from '../service/webhook-handler.ts';
import { type CallbackReply, receiveGatewayCallback, receiveSepay } from '../service/webhooks.ts';

const inputOf = (req: Request): CallbackInput => ({ query: req.query as Record<string, unknown>, body: req.body, headers: req.headers });

/**
 * Phản hồi cho cổng theo định dạng riêng của cổng (Documents/21 T6): ngoại lệ có chủ đích với luật "không tự đặt
 * `res.status` trong controller", vì cổng không đọc Problem Details. MoMo 204 không body.
 */
function send(res: Response, r: CallbackReply): void {
  if (r.body === undefined) res.status(r.status).end();
  else res.status(r.status).json(r.body);
}

/**
 * Webhook của 4 cổng, gắn tại /api/v1/payment/webhooks. **Không token, không kiểm quyền người dùng**, không bị chặn bởi
 * công ty khoá hay phân hệ tắt (T6, V20): xác thực bằng chữ ký của cổng (SePay: API key).
 */
export function webhookRouter(ctx: PaymentContext): Router {
  const router = Router();
  router.get('/vnpay', async (req, res) => send(res, await receiveGatewayCallback(ctx, 'vnpay', inputOf(req))));
  router.post('/momo', async (req, res) => send(res, await receiveGatewayCallback(ctx, 'momo', inputOf(req))));
  router.post('/zalopay', async (req, res) => send(res, await receiveGatewayCallback(ctx, 'zalopay', inputOf(req))));
  router.post('/sepay/:receiverKey', async (req, res) =>
    send(res, await receiveSepay(ctx, String(req.params.receiverKey), inputOf(req))),
  );
  return router;
}
