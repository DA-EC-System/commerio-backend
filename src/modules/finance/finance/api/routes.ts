import { Router } from 'express';
import type { FinanceContext } from '../service/settlement-views.ts';
import { mountConfigRoutes } from './config-routes.ts';
import { mountLedgerRoutes } from './ledger-routes.ts';
import { mountPaymentRoutes } from './payment-routes.ts';
import { mountSettlementRoutes } from './settlement-routes.ts';

/**
 * Route của module `finance`, gắn tại /api/v1/finance (Documents/21 mục 21): sổ tiền, trạng thái tiền của đơn, đối
 * soát, phiên bản cấu hình. Route tiền cũ (`invoices`, `receipts`, `payment-vouchers`, `cod-orders`,
 * `cod-confirmations`, `unmatched-receipts`, `refunds`) đã gỡ ở #235, gọi vào trả 404.
 */
export function financeRouter(ctx: FinanceContext): Router {
  const router = Router();
  mountSettlementRoutes(router, ctx);
  mountConfigRoutes(router, ctx);
  mountLedgerRoutes(router, ctx);
  mountPaymentRoutes(router, ctx);
  return router;
}
