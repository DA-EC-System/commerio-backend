import { type Response, Router } from 'express';
import { getAuth } from '../../../../shared/auth/authenticate.ts';
import { getAccess } from '../../../../shared/auth/authorize.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { validate, validated } from '../../../../shared/http/validate.ts';
import { packageDocuments } from '../service/documents.ts';
import { type Actor, handOverPackages, undoHandover } from '../service/handover.ts';
import { type FulfillmentContext, getPackage, listPackages } from '../service/packages.ts';
import { carriersOf, markReady, openPackage, packPackage, pickList } from '../service/packing.ts';
import { HandOverBody, OpenBody, PackBody, PackageDocumentsQuery, PackageListQuery, PackageParams, PickListQuery, ReadyBody, UndoHandoverBody } from './schemas.ts';

function actor(res: Response): Actor {
  const { accountId, companyId } = getAuth(res);
  const { permissions, enabledModules } = getAccess(res);
  return { accountId, companyId: companyId!, permissions, enabledModules };
}

/** Route của module `fulfillment`, gắn tại /api/v1/fulfillment (Documents/21 §19.2). */
export function fulfillmentRouter(ctx: FulfillmentContext): Router {
  const router = Router();
  const process = ctx.authorize('fulfillment.order.process');

  router.get('/packages', process, validate({ query: PackageListQuery }), async (_req, res) => {
    const query = validated<typeof PackageListQuery>(res, 'query');
    res.json(await withCompany(getAuth(res).companyId!, () => listPackages(ctx, query)));
  });

  // Mỗi kiện một giao dịch (service tự mở `withCompany`): kiện lỗi không chặn kiện khác.
  router.post('/packages/hand-over', process, validate({ body: HandOverBody }), async (_req, res) => {
    res.json(await handOverPackages(ctx, actor(res), validated<typeof HandOverBody>(res, 'body').packages));
  });

  router.post(
    '/packages/:id/undo-handover',
    ctx.authorize('fulfillment.handover.revert'),
    validate({ params: PackageParams, body: UndoHandoverBody }),
    async (_req, res) => {
      const { id } = validated<typeof PackageParams>(res, 'params');
      res.json(await undoHandover(ctx, actor(res), id, validated<typeof UndoHandoverBody>(res, 'body')));
    },
  );

  router.get('/pick-list', process, validate({ query: PickListQuery }), async (_req, res) => {
    const { ids } = validated<typeof PickListQuery>(res, 'query');
    res.json(await withCompany(getAuth(res).companyId!, () => pickList(ctx, ids)));
  });

  router.get('/packages/:id/carriers', process, validate({ params: PackageParams }), async (_req, res) => {
    const { id } = validated<typeof PackageParams>(res, 'params');
    res.json(await carriersOf(ctx, getAuth(res).companyId!, id));
  });

  router.post('/packages/:id/pack', process, validate({ params: PackageParams, body: PackBody }), async (_req, res) => {
    const { id } = validated<typeof PackageParams>(res, 'params');
    res.json(await packPackage(ctx, actor(res), id, validated<typeof PackBody>(res, 'body')));
  });

  router.post('/packages/:id/ready', process, validate({ params: PackageParams, body: ReadyBody }), async (_req, res) => {
    const { id } = validated<typeof PackageParams>(res, 'params');
    res.json(await markReady(ctx, actor(res), id, validated<typeof ReadyBody>(res, 'body')));
  });

  router.post('/packages/:id/open', process, validate({ params: PackageParams, body: OpenBody }), async (_req, res) => {
    const { id } = validated<typeof PackageParams>(res, 'params');
    res.json(await openPackage(ctx, actor(res), id, validated<typeof OpenBody>(res, 'body')));
  });

  router.get('/packages/documents', process, validate({ query: PackageDocumentsQuery }), async (_req, res) => {
    const { ids } = validated<typeof PackageDocumentsQuery>(res, 'query');
    const { pdf, filename } = await packageDocuments(ctx, getAuth(res).companyId!, ids);
    res.type('application/pdf').set('Content-Disposition', `attachment; filename="${filename}"`).send(Buffer.from(pdf));
  });

  router.get('/packages/:id', process, validate({ params: PackageParams }), async (_req, res) => {
    const { id } = validated<typeof PackageParams>(res, 'params');
    res.json(await withCompany(getAuth(res).companyId!, () => getPackage(ctx, id)));
  });

  return router;
}
