import { type Response, Router } from 'express';
import { getAuth } from '../../../../shared/auth/authenticate.ts';
import { anyOf, getAccess } from '../../../../shared/auth/authorize.ts';
import { validate, validated } from '../../../../shared/http/validate.ts';
import type { ModuleContext } from '../../../../shared/module.ts';
import { runRequestAction } from '../service/request-actions.ts';
import type { Actor } from '../service/request-views.ts';
import * as requests from '../service/requests.ts';
import * as suppliers from '../service/suppliers.ts';
import {
  ActionParams,
  AddRequestLineInput,
  ExcludeLineInput,
  IdParams,
  LineParams,
  PurchaseRequestInput,
  PurchaseRequestUpdateInput,
  RequestActionInput,
  RequestListQuery,
  SupplierInput,
  SupplierListQuery,
  SupplierUpdateInput,
} from './schemas.ts';

/** Người gọi kèm quyền lấy từ lần đọc DB của `authorize` trong chính request này (D1). */
function actor(res: Response): Actor {
  const { accountId, companyId } = getAuth(res);
  const { permissions, enabledModules } = getAccess(res);
  return { accountId, companyId: companyId!, permissions, enabledModules };
}

/** Route của module `purchasing`, gắn tại /api/v1/purchasing (Documents/21 mục 16.2). Phiếu nhận ở #109. */
export function purchasingRouter(ctx: ModuleContext): Router {
  const router = Router();
  // Xem danh sách, chi tiết: có ít nhất một quyền purchasing.* (Documents/21 mục 16.1).
  const view = anyOf(
    ctx.authorize('purchasing.request.manage'),
    ctx.authorize('purchasing.request.approve'),
    ctx.authorize('purchasing.receipt.manage'),
    ctx.authorize('purchasing.return.manage'),
  );
  const manage = ctx.authorize('purchasing.request.manage');
  const approve = ctx.authorize('purchasing.request.approve');

  router.get('/suppliers', view, validate({ query: SupplierListQuery }), async (_req, res) => {
    res.json(await suppliers.listSuppliers(actor(res).companyId, validated<typeof SupplierListQuery>(res, 'query')));
  });

  router.post('/suppliers', manage, validate({ body: SupplierInput }), async (_req, res) => {
    res.status(201).json(await suppliers.createSupplier(actor(res), validated<typeof SupplierInput>(res, 'body')));
  });

  router.put('/suppliers/:id', manage, validate({ params: IdParams, body: SupplierUpdateInput }), async (_req, res) => {
    const { id } = validated<typeof IdParams>(res, 'params');
    res.json(await suppliers.updateSupplier(actor(res), id, validated<typeof SupplierUpdateInput>(res, 'body')));
  });

  router.get('/requests', view, validate({ query: RequestListQuery }), async (_req, res) => {
    res.json(await requests.listRequestPage(actor(res), validated<typeof RequestListQuery>(res, 'query')));
  });

  router.post('/requests', manage, validate({ body: PurchaseRequestInput }), async (_req, res) => {
    res.status(201).json(await requests.createRequest(actor(res), validated<typeof PurchaseRequestInput>(res, 'body')));
  });

  router.post('/requests/add-line', manage, validate({ body: AddRequestLineInput }), async (_req, res) => {
    const { created, request } = await requests.addLine(actor(res), validated<typeof AddRequestLineInput>(res, 'body'));
    res.status(created ? 201 : 200).json(request);
  });

  router.get('/requests/:id', view, validate({ params: IdParams }), async (_req, res) => {
    res.json(await requests.getRequest(actor(res), validated<typeof IdParams>(res, 'params').id));
  });

  router.put('/requests/:id', manage, validate({ params: IdParams, body: PurchaseRequestUpdateInput }), async (_req, res) => {
    const { id } = validated<typeof IdParams>(res, 'params');
    res.json(await requests.updateRequestDraft(actor(res), id, validated<typeof PurchaseRequestUpdateInput>(res, 'body')));
  });

  router.post(
    '/requests/:id/lines/:lineId/exclude',
    approve,
    validate({ params: LineParams, body: ExcludeLineInput }),
    async (_req, res) => {
      const { id, lineId } = validated<typeof LineParams>(res, 'params');
      res.json(await requests.excludeLine(actor(res), id, lineId, validated<typeof ExcludeLineInput>(res, 'body')));
    },
  );

  // Quyền của từng bước do máy trạng thái kiểm (`assertTransition`), route chỉ cần quyền xem.
  router.post('/requests/:id/:action', view, validate({ params: ActionParams, body: RequestActionInput }), async (_req, res) => {
    const { id, action } = validated<typeof ActionParams>(res, 'params');
    res.json(await runRequestAction(actor(res), id, action, validated<typeof RequestActionInput>(res, 'body')));
  });

  return router;
}
