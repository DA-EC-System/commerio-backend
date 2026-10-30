import { Router } from 'express';
import { getAuth } from '../../../../shared/auth/authenticate.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { validate, validated } from '../../../../shared/http/validate.ts';
import { getOrder, listOrders, type SalesContext } from '../service/orders.ts';
import { OrderListQuery, OrderParams } from './schemas.ts';

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

  return router;
}
