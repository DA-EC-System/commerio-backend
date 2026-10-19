import { type RequestHandler, Router } from 'express';
import { getAuth } from '../../../shared/auth/authenticate.ts';
import { anyOf, getAccess } from '../../../shared/auth/authorize.ts';
import { env } from '../../../shared/config/env.ts';
import { AppError } from '../../../shared/errors/app-error.ts';
import { validate, validated } from '../../../shared/http/validate.ts';
import { type Credentials, GATEWAYS, type Gateway, isGateway } from '../domain/gateways.ts';
import { listGatewayConfigs, listGatewaySummaries, saveGatewayConfig } from '../service/gateway-configs.ts';
import { createPaymentLink, getOrderPaymentView } from '../service/payment-links.ts';
import { getTransaction, listTransactions } from '../service/transactions.ts';
import type { PaymentContext } from '../service/webhook-handler.ts';
import { simulatePayment } from '../service/webhooks.ts';
import { listUnpaidOrders } from '../service/order-list.ts';
import { CreateLinkBody, gatewayConfigBodyOf, OrderParams, TransactionListQuery, TransactionParams, UnpaidOrderListQuery } from './schemas.ts';
import { webhookRouter } from './webhooks.ts';

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
  router.use('/webhooks', webhookRouter(ctx));
  const manageGateways = ctx.authorize('payment.gateway.manage');
  const createLink = ctx.authorize('payment.link.create');

  // Danh sách cổng: người quản lý khoá thấy bản đã che; Sale (chỉ `payment.link.create`) thấy tên cổng và cờ (§12.3).
  router.get('/gateways', anyOf(manageGateways, createLink), async (_req, res) => {
    const companyId = getAuth(res).companyId!;
    const fullView = getAccess(res).permissions.includes('payment.gateway.manage');
    res.json(fullView ? await listGatewayConfigs(companyId) : await listGatewaySummaries(companyId));
  });

  router.put('/gateways/:gateway', manageGateways, requireGateway, async (_req, res) => {
    const { accountId, companyId } = getAuth(res);
    // Schema thân khác nhau theo cổng (`requireGateway`), chung phần `credentials`, `version`.
    const { credentials, version } = validated(res, 'body') as { credentials: Credentials; version: number };
    const gateway = res.locals.gateway as Gateway;
    res.json(await saveGatewayConfig({ accountId, companyId: companyId! }, gateway, credentials, version));
  });

  router.post(
    '/orders/:orderId/links',
    createLink,
    validate({ params: OrderParams, body: CreateLinkBody }),
    async (req, res) => {
      const { accountId, companyId } = getAuth(res);
      const { orderId } = validated<typeof OrderParams>(res, 'params');
      const { gateway } = validated<typeof CreateLinkBody>(res, 'body');
      const result = await createPaymentLink({ accountId, companyId: companyId!, ip: req.ip ?? '' }, orderId, gateway);
      res.status(result.created ? 201 : 200).json(result.link);
    },
  );

  router.get('/orders/:orderId', ctx.authorize('sales.order.view'), validate({ params: OrderParams }), async (_req, res) => {
    const { orderId } = validated<typeof OrderParams>(res, 'params');
    res.json(await getOrderPaymentView(getAuth(res).companyId!, orderId));
  });

  // Đơn chưa thu cho hộp gán khoản thu chưa khớp (#27 R1): chỉ người xử lý khoản thu dùng.
  router.get('/orders', ctx.authorize('finance.voucher.create'), validate({ query: UnpaidOrderListQuery }), async (_req, res) => {
    res.json(await listUnpaidOrders(getAuth(res).companyId!, validated<typeof UnpaidOrderListQuery>(res, 'query')));
  });

  // Giao dịch cổng (#27, §12.3): `from`/`to` là trọn ngày giờ VN (C6).
  const viewTransactions = ctx.authorize('payment.transaction.view');
  router.get('/transactions', viewTransactions, validate({ query: TransactionListQuery }), async (_req, res) => {
    res.json(await listTransactions(ctx, getAuth(res).companyId!, validated<typeof TransactionListQuery>(res, 'query')));
  });
  router.get('/transactions/:id', viewTransactions, validate({ params: TransactionParams }), async (_req, res) => {
    const { id } = validated<typeof TransactionParams>(res, 'params');
    res.json(await getTransaction(ctx, getAuth(res).companyId!, id));
  });

  // Mô phỏng trả tiền cho demo/E2E (§12.11, #27 A12): không gắn ở production.
  if (env.NODE_ENV !== 'production') {
    router.post('/dev/simulate/:paymentCode', createLink, async (req, res) => {
      res.json(await simulatePayment(ctx, getAuth(res).companyId!, String(req.params.paymentCode)));
    });
  }

  return router;
}
