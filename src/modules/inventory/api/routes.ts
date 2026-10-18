import { type Response, Router } from 'express';
import type { z } from 'zod';
import { getAuth } from '../../../shared/auth/authenticate.ts';
import { validate } from '../../../shared/http/validate.ts';
import type { ModuleContext } from '../../../shared/module.ts';
import { loadCompanyAccess } from '../../identity/index.ts';
import * as documents from '../service/documents.ts';
import * as stock from '../service/stock.ts';
import type { Viewer } from '../service/views.ts';
import {
  CreateDocBody,
  DocListQuery,
  IdParams,
  ReorderRuleBody,
  StockListQuery,
  UpdateDocBody,
  VariantParams,
  VersionBody,
} from './schemas.ts';

const validated = <T extends z.ZodType>(res: Response, part: 'body' | 'query' | 'params') =>
  (res.locals.validated as Record<string, z.output<T>>)[part]!;

/**
 * Người gọi và hai quyền đổi dữ liệu trả về, đọc từ DB mỗi request như `authorize` (D1, plan #16 A1): thu quyền giá
 * vốn thì lần gọi sau thấy `null` ngay, không chờ token hết hạn.
 */
async function viewer(res: Response): Promise<Viewer> {
  const { accountId, companyId } = getAuth(res);
  const access = await loadCompanyAccess(accountId, companyId!);
  const permissions = access?.permissions ?? [];
  return {
    accountId,
    companyId: companyId!,
    canCost: permissions.includes('inventory.cost.view'),
    canCreate: permissions.includes('inventory.receipt.create'),
  };
}

/** Route của module `inventory`, gắn tại /api/v1/inventory (Documents/21 7.1). `/returns` thuộc #25 (AC-16). */
export function inventoryRouter(ctx: ModuleContext): Router {
  const router = Router();
  const view = ctx.authorize('inventory.stock.view');
  const manage = ctx.authorize('inventory.receipt.create');
  const reorder = ctx.authorize('inventory.reorder.manage');

  router.get('/stock', view, validate({ query: StockListQuery }), async (_req, res) => {
    res.json(await stock.listStock(await viewer(res), validated<typeof StockListQuery>(res, 'query')));
  });

  router.get('/stock/:variantId', view, validate({ params: VariantParams }), async (_req, res) => {
    res.json(await stock.getStock(await viewer(res), validated<typeof VariantParams>(res, 'params').variantId));
  });

  router.put(
    '/stock/:variantId/reorder-rule',
    reorder,
    validate({ params: VariantParams, body: ReorderRuleBody }),
    async (_req, res) => {
      const { variantId } = validated<typeof VariantParams>(res, 'params');
      res.json(await stock.setReorderRule(await viewer(res), variantId, validated<typeof ReorderRuleBody>(res, 'body')));
    },
  );

  router.get('/documents', view, validate({ query: DocListQuery }), async (_req, res) => {
    res.json(await documents.listDocuments(await viewer(res), validated<typeof DocListQuery>(res, 'query')));
  });

  router.get('/documents/:id', view, validate({ params: IdParams }), async (_req, res) => {
    res.json(await documents.getDocument(await viewer(res), validated<typeof IdParams>(res, 'params').id));
  });

  router.post('/documents', manage, validate({ body: CreateDocBody }), async (_req, res) => {
    res.status(201).json(await documents.createDocument(await viewer(res), validated<typeof CreateDocBody>(res, 'body')));
  });

  router.put('/documents/:id', manage, validate({ params: IdParams, body: UpdateDocBody }), async (_req, res) => {
    const { id } = validated<typeof IdParams>(res, 'params');
    res.json(await documents.updateDocument(await viewer(res), id, validated<typeof UpdateDocBody>(res, 'body')));
  });

  router.post('/documents/:id/post', manage, validate({ params: IdParams, body: VersionBody }), async (_req, res) => {
    const { id } = validated<typeof IdParams>(res, 'params');
    res.json(await documents.postDocument(await viewer(res), id, validated<typeof VersionBody>(res, 'body').version));
  });

  router.post('/documents/:id/cancel', manage, validate({ params: IdParams, body: VersionBody }), async (_req, res) => {
    const { id } = validated<typeof IdParams>(res, 'params');
    res.json(await documents.cancelDocument(await viewer(res), id, validated<typeof VersionBody>(res, 'body').version));
  });

  return router;
}
