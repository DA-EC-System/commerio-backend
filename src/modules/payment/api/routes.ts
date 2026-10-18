import { type RequestHandler, Router } from 'express';
import { getAuth } from '../../../shared/auth/authenticate.ts';
import { AppError } from '../../../shared/errors/app-error.ts';
import { validate } from '../../../shared/http/validate.ts';
import { type Credentials, GATEWAYS, type Gateway, isGateway } from '../domain/gateways.ts';
import { listGatewayConfigs, listGatewaySummaries, saveGatewayConfig } from '../service/gateway-configs.ts';
import type { PaymentContext } from '../service/webhook-handler.ts';
import { gatewayConfigBodyOf } from './schemas.ts';

const validateGatewayBody = Object.fromEntries(GATEWAYS.map((g) => [g, validate({ body: gatewayConfigBodyOf(g) })])) as Record<
  Gateway,
  RequestHandler
>;

/** Cổng trong đường dẫn: ngoài 4 cổng là 404 (§12.3), không phải 422. Đặt sau `authorize` để thiếu quyền vẫn ra 403. */
const requireGateway: RequestHandler = (req, res, next) => {
  const gateway = String(req.params.gateway);
  if (!isGateway(gateway)) throw new AppError(404, 'not_found', 'Không có cổng thanh toán này');
  res.locals.gateway = gateway;
  validateGatewayBody[gateway](req, res, next);
};

/**
 * Route của module `payment`, gắn tại /api/v1/payment. Kiểm quyền bằng `ctx.authorize(...)`; webhook sau khi kiểm
 * chữ ký giao cho `verifiedPaymentHandlerOf(ctx)` (handler của finance, A11).
 */
export function paymentRouter(ctx: PaymentContext): Router {
  const router = Router();
  const manageGateways = ctx.authorize('payment.gateway.manage');
  const createLink = ctx.authorize('payment.link.create');

  // Danh sách cổng: người quản lý khoá thấy bản đã che; Sale (chỉ `payment.link.create`) thấy tên cổng và cờ (§12.3).
  // Thử quyền quản lý trước, thiếu (`forbidden`) thì thử quyền tạo mã, như `access/api/routes.ts`.
  const viewGateways: RequestHandler = async (req, res, next) => {
    try {
      await manageGateways(req, res, () => {
        res.locals.gatewayFullView = true;
        next();
      });
    } catch (err) {
      if (!(err instanceof AppError && err.code === 'forbidden')) throw err;
      await createLink(req, res, next);
    }
  };

  router.get('/gateways', viewGateways, async (_req, res) => {
    const companyId = getAuth(res).companyId!;
    res.json(res.locals.gatewayFullView ? await listGatewayConfigs(companyId) : await listGatewaySummaries(companyId));
  });

  router.put('/gateways/:gateway', manageGateways, requireGateway, async (_req, res) => {
    const { accountId, companyId } = getAuth(res);
    const { credentials, version } = (res.locals.validated as { body: { credentials: Credentials; version: number } }).body;
    const gateway = res.locals.gateway as Gateway;
    res.json(await saveGatewayConfig({ accountId, companyId: companyId! }, gateway, credentials, version));
  });

  return router;
}
