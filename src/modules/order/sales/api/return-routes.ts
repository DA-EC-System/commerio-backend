import { type Response, Router } from 'express';
import { getAuth } from '../../../../shared/auth/authenticate.ts';
import { getAccess } from '../../../../shared/auth/authorize.ts';
import { validate, validated } from '../../../../shared/http/validate.ts';
import type { Actor } from '../service/cancel.ts';
import type { SalesContext } from '../service/orders.ts';
import { attachUnmatched, dismissUnmatched, listUnmatched, receiveReturn } from '../service/return-receive.ts';
import { actOnReturn, getReturn, listReturns, platformHistory, returnReasons, type UserReturnAction } from '../service/returns.ts';
import {
  AttachBody,
  DismissBody,
  ReasonsQuery,
  ReceiveReturnBody,
  ReturnActionBody,
  ReturnActionParams,
  ReturnListQuery,
  ReturnParams,
  UnmatchedQuery,
} from './return-schemas.ts';

function actor(res: Response): Actor {
  const { accountId, companyId } = getAuth(res);
  const { permissions, enabledModules } = getAccess(res);
  return { accountId, companyId: companyId!, permissions, enabledModules };
}

const ACTION: Record<(typeof ReturnActionParams.shape.action.options)[number], UserReturnAction> = {
  accept: 'accept',
  reject: 'reject',
  'refund-only': 'refund_only',
  'platform-reopen': 'platform_reopen',
  'platform-refund': 'platform_refund',
  'no-show': 'no_show',
};

/** Route yêu cầu trả, gắn tại /api/v1/returns (Documents/21 §20, §20.1). Route cố định đặt trước `/:id`. */
export function returnsRouter(ctx: SalesContext): Router {
  const router = Router();
  const view = ctx.authorize('sales.return.view');
  const process = ctx.authorize('sales.return.process');
  const warehouse = ctx.authorize('fulfillment.order.process');

  router.get('/', view, validate({ query: ReturnListQuery }), async (_req, res) => {
    res.json(await listReturns(ctx, getAuth(res).companyId!, validated<typeof ReturnListQuery>(res, 'query')));
  });

  router.post('/receive', warehouse, validate({ body: ReceiveReturnBody }), async (_req, res) => {
    res.json(await receiveReturn(ctx, actor(res), validated<typeof ReceiveReturnBody>(res, 'body')));
  });

  router.get('/unmatched', view, validate({ query: UnmatchedQuery }), async (_req, res) => {
    res.json(await listUnmatched(getAuth(res).companyId!, validated<typeof UnmatchedQuery>(res, 'query').status));
  });

  router.post('/unmatched/:id/attach', warehouse, validate({ params: ReturnParams, body: AttachBody }), async (_req, res) => {
    const { id } = validated<typeof ReturnParams>(res, 'params');
    res.json(await attachUnmatched(ctx, actor(res), id, validated<typeof AttachBody>(res, 'body')));
  });

  router.post('/unmatched/:id/dismiss', warehouse, validate({ params: ReturnParams, body: DismissBody }), async (_req, res) => {
    const { id } = validated<typeof ReturnParams>(res, 'params');
    res.json(await dismissUnmatched(actor(res), id, validated<typeof DismissBody>(res, 'body')));
  });

  router.get('/:id', view, validate({ params: ReturnParams }), async (_req, res) => {
    res.json(await getReturn(ctx, actor(res), validated<typeof ReturnParams>(res, 'params').id));
  });

  router.get('/:id/reasons', process, validate({ params: ReturnParams, query: ReasonsQuery }), async (_req, res) => {
    const { id } = validated<typeof ReturnParams>(res, 'params');
    res.json(await returnReasons(ctx, actor(res), id, validated<typeof ReasonsQuery>(res, 'query').action));
  });

  router.get('/:id/platform-history', view, validate({ params: ReturnParams }), async (_req, res) => {
    res.json(await platformHistory(ctx, actor(res), validated<typeof ReturnParams>(res, 'params').id));
  });

  // Route chặn người thiếu `sales.return.process`; máy trạng thái kiểm lại quyền, guard và lý do của từng bước.
  router.post('/:id/:action', process, validate({ params: ReturnActionParams, body: ReturnActionBody }), async (_req, res) => {
    const { id, action } = validated<typeof ReturnActionParams>(res, 'params');
    res.json(await actOnReturn(ctx, actor(res), id, ACTION[action], validated<typeof ReturnActionBody>(res, 'body')));
  });

  return router;
}
