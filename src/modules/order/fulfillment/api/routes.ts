import { Router } from 'express';
import { getAuth } from '../../../../shared/auth/authenticate.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { validate, validated } from '../../../../shared/http/validate.ts';
import { type FulfillmentContext, getPackage, listPackages } from '../service/packages.ts';
import { PackageListQuery, PackageParams } from './schemas.ts';

/** Route của module `fulfillment`, gắn tại /api/v1/fulfillment (Documents/21 §19.2). */
export function fulfillmentRouter(ctx: FulfillmentContext): Router {
  const router = Router();
  const process = ctx.authorize('fulfillment.order.process');

  router.get('/packages', process, validate({ query: PackageListQuery }), async (_req, res) => {
    const query = validated<typeof PackageListQuery>(res, 'query');
    res.json(await withCompany(getAuth(res).companyId!, () => listPackages(ctx, query)));
  });

  router.get('/packages/:id', process, validate({ params: PackageParams }), async (_req, res) => {
    const { id } = validated<typeof PackageParams>(res, 'params');
    res.json(await withCompany(getAuth(res).companyId!, () => getPackage(ctx, id)));
  });

  return router;
}
