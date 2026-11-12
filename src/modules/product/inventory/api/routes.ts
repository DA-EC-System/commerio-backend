import { type Response, Router } from 'express';
import { getAuth } from '../../../../shared/auth/authenticate.ts';
import { anyOf, getAccess } from '../../../../shared/auth/authorize.ts';
import { validate, validated } from '../../../../shared/http/validate.ts';
import * as docs from '../service/documents.ts';
import * as stock from '../service/stock.ts';
import { type InventoryContext, incomingLookupOf, purchaseNumbersOf, type Viewer } from '../service/views.ts';
import {
  DocActionBody,
  DocActionParams,
  DocCreateBody,
  DocDecideBody,
  DocListQuery,
  DocParams,
  DocUpdateBody,
  ReorderRuleBody,
  StockListQuery,
  VariantParams,
} from './schemas.ts';

/**
 * Người gọi và hai quyền đổi dữ liệu trả về, lấy từ lần đọc DB của `authorize` trong chính request này (D1, plan #16
 * A1): thu quyền giá vốn thì lần gọi sau thấy `null` ngay, không chờ token hết hạn.
 */
function viewer(res: Response): Viewer {
  const { accountId, companyId } = getAuth(res);
  const { permissions } = getAccess(res);
  return {
    accountId,
    companyId: companyId!,
    canCost: permissions.includes('inventory.cost.view'),
  };
}

/** Người làm thao tác phiếu kho: quyền và phân hệ bật lấy nguyên từ `getAccess` cho máy trạng thái (§14.1). */
function actor(res: Response): docs.DocActor {
  const { permissions, enabledModules } = getAccess(res);
  return { ...viewer(res), permissions, enabledModules };
}

/** Route của module `inventory`, gắn tại /api/v1/inventory (Documents/21 mục 15.2; phiếu kho có duyệt #208). */
export function inventoryRouter(ctx: InventoryContext): Router {
  const router = Router();
  const view = ctx.authorize('inventory.stock.view');
  const reorder = ctx.authorize('inventory.reorder.manage');

  router.get('/stock', view, validate({ query: StockListQuery }), async (_req, res) => {
    res.json(await stock.listStock(incomingLookupOf(ctx), viewer(res), validated<typeof StockListQuery>(res, 'query')));
  });

  router.get('/stock/:variantId', view, validate({ params: VariantParams }), async (_req, res) => {
    const lookups = { incomingOf: incomingLookupOf(ctx), purchaseNumbers: purchaseNumbersOf(ctx) };
    res.json(await stock.getStock(lookups, viewer(res), validated<typeof VariantParams>(res, 'params').variantId));
  });

  router.put(
    '/stock/:variantId/reorder-rule',
    reorder,
    validate({ params: VariantParams, body: ReorderRuleBody }),
    async (_req, res) => {
      const { variantId } = validated<typeof VariantParams>(res, 'params');
      res.json(await stock.setReorderRule(incomingLookupOf(ctx), viewer(res), variantId, validated<typeof ReorderRuleBody>(res, 'body')));
    },
  );

  const manage = ctx.authorize('inventory.receipt.create');
  // Quyền từng bước kiểm ở máy trạng thái (§15.3): ở route chỉ cần một trong hai quyền phiếu kho.
  const act = anyOf(manage, ctx.authorize('inventory.document.approve'));

  router.get('/documents', view, validate({ query: DocListQuery }), async (_req, res) => {
    res.json(await docs.listDocuments(viewer(res), validated<typeof DocListQuery>(res, 'query')));
  });

  router.get('/documents/:id', view, validate({ params: DocParams }), async (_req, res) => {
    res.json(await docs.getDocument(viewer(res), validated<typeof DocParams>(res, 'params').id));
  });

  router.post('/documents', manage, validate({ body: DocCreateBody }), async (_req, res) => {
    res.status(201).json(await docs.createDocument(actor(res), validated<typeof DocCreateBody>(res, 'body')));
  });

  router.put('/documents/:id', manage, validate({ params: DocParams, body: DocUpdateBody }), async (_req, res) => {
    const { id } = validated<typeof DocParams>(res, 'params');
    res.json(await docs.updateDocument(actor(res), id, validated<typeof DocUpdateBody>(res, 'body')));
  });

  router.post('/documents/:id/decide', manage, validate({ params: DocParams, body: DocDecideBody }), async (_req, res) => {
    const { id } = validated<typeof DocParams>(res, 'params');
    res.json(await docs.decideDocument(actor(res), id, validated<typeof DocDecideBody>(res, 'body')));
  });

  router.post('/documents/:id/:action', act, validate({ params: DocActionParams, body: DocActionBody }), async (_req, res) => {
    const { id, action } = validated<typeof DocActionParams>(res, 'params');
    res.json(await docs.actOnDocument(actor(res), id, action, validated<typeof DocActionBody>(res, 'body')));
  });

  return router;
}
