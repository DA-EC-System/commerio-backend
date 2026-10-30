import { type Response, Router } from 'express';
import { getAuth } from '../../../../shared/auth/authenticate.ts';
import { getAccess } from '../../../../shared/auth/authorize.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { validate, validated } from '../../../../shared/http/validate.ts';
import { type Actor, cancelOnPlatform, cancelReasons, decideCancelRequest, setInvoiceNumber } from '../service/cancel.ts';
import { getOrder, listOrders, type SalesContext } from '../service/orders.ts';
import { CancelRequestBody, InvoiceNumberBody, OrderListQuery, OrderParams, PlatformCancelBody } from './schemas.ts';

function actor(res: Response): Actor {
  const { accountId, companyId } = getAuth(res);
  const { permissions, enabledModules } = getAccess(res);
  return { accountId, companyId: companyId!, permissions, enabledModules };
}

/** Route của module `sales`, gắn tại /api/v1/sales (Documents/21 §19.1, §19.3). */
export function salesRouter(ctx: SalesContext): Router {
  const router = Router();
  const view = ctx.authorize('sales.order.view');

  router.get('/orders', view, validate({ query: OrderListQuery }), async (_req, res) => {
    const query = validated<typeof OrderListQuery>(res, 'query');
    res.json(await withCompany(getAuth(res).companyId!, () => listOrders(ctx, query)));
  });

  router.get('/orders/:id', view, validate({ params: OrderParams }), async (_req, res) => {
    const { id } = validated<typeof OrderParams>(res, 'params');
    res.json(await withCompany(getAuth(res).companyId!, () => getOrder(ctx, id)));
  });

  // Thao tác đơn sàn (§19.3): gọi sàn ngoài giao dịch, service tự mở `withCompany` trước và sau.
  const cancel = ctx.authorize('sales.order.cancel');
  const params = (res: Response) => validated<typeof OrderParams>(res, 'params').id;

  router.get('/orders/:id/cancel-reasons', cancel, validate({ params: OrderParams }), async (_req, res) => {
    res.json(await cancelReasons(ctx, actor(res), params(res)));
  });

  router.post('/orders/:id/platform-cancel', cancel, validate({ params: OrderParams, body: PlatformCancelBody }), async (_req, res) => {
    res.json(await cancelOnPlatform(ctx, actor(res), params(res), validated<typeof PlatformCancelBody>(res, 'body')));
  });

  router.post('/orders/:id/cancel-request', cancel, validate({ params: OrderParams, body: CancelRequestBody }), async (_req, res) => {
    res.json(await decideCancelRequest(ctx, actor(res), params(res), validated<typeof CancelRequestBody>(res, 'body')));
  });

  router.put(
    '/orders/:id/invoice-number',
    ctx.authorize('sales.order.create'),
    validate({ params: OrderParams, body: InvoiceNumberBody }),
    async (_req, res) => {
      res.json(await setInvoiceNumber(ctx, actor(res), params(res), validated<typeof InvoiceNumberBody>(res, 'body')));
    },
  );

  return router;
}
