import { type Response, Router } from 'express';
import { getAuth } from '../../../../shared/auth/authenticate.ts';
import { getAccess } from '../../../../shared/auth/authorize.ts';
import { validate, validated } from '../../../../shared/http/validate.ts';
import type { ModuleContext } from '../../../../shared/module.ts';
import * as stock from '../service/stock.ts';
import type { Viewer } from '../service/views.ts';
import { ReorderRuleBody, StockListQuery, VariantParams } from './schemas.ts';

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

/** Route của module `inventory`, gắn tại /api/v1/inventory (Documents/21 mục 15.2). Phiếu kho làm ở issue B3. */
export function inventoryRouter(ctx: ModuleContext): Router {
  const router = Router();
  const view = ctx.authorize('inventory.stock.view');
  const reorder = ctx.authorize('inventory.reorder.manage');

  router.get('/stock', view, validate({ query: StockListQuery }), async (_req, res) => {
    res.json(await stock.listStock(viewer(res), validated<typeof StockListQuery>(res, 'query')));
  });

  router.get('/stock/:variantId', view, validate({ params: VariantParams }), async (_req, res) => {
    res.json(await stock.getStock(viewer(res), validated<typeof VariantParams>(res, 'params').variantId));
  });

  router.put(
    '/stock/:variantId/reorder-rule',
    reorder,
    validate({ params: VariantParams, body: ReorderRuleBody }),
    async (_req, res) => {
      const { variantId } = validated<typeof VariantParams>(res, 'params');
      res.json(await stock.setReorderRule(viewer(res), variantId, validated<typeof ReorderRuleBody>(res, 'body')));
    },
  );

  return router;
}
