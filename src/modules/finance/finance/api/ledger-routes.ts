import type { Response, Router } from 'express';
import { getAuth } from '../../../../shared/auth/authenticate.ts';
import { validate, validated as input } from '../../../../shared/http/validate.ts';
import { getTaxWarnings, listLedger, orderProfit } from '../service/ledger.ts';
import type { FinanceContext } from '../service/settlement-views.ts';
import { canSeeCost, financeView } from './access.ts';
import { LedgerListQuery, OrderIdParams } from './ledger-schemas.ts';

const companyOf = (res: Response) => getAuth(res).companyId!;

/** Sổ tiền, lãi theo đơn, cảnh báo mốc thuế (Documents/21 §21.1; #116), gắn vào router của finance. */
export function mountLedgerRoutes(router: Router, ctx: FinanceContext): void {
  const view = financeView(ctx);

  router.get('/ledger', view, validate({ query: LedgerListQuery }), async (_req, res) => {
    res.json(await listLedger(companyOf(res), input<typeof LedgerListQuery>(res, 'query'), canSeeCost(res)));
  });
  router.get('/orders/:orderId/profit', view, validate({ params: OrderIdParams }), async (_req, res) => {
    res.json(await orderProfit(companyOf(res), input<typeof OrderIdParams>(res, 'params').orderId, canSeeCost(res)));
  });
  router.get('/tax-warnings', view, async (_req, res) => {
    res.json(await getTaxWarnings(companyOf(res)));
  });
}
