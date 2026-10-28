import type { Response, Router } from 'express';
import { getAuth } from '../../../../shared/auth/authenticate.ts';
import { getAccess } from '../../../../shared/auth/authorize.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { validate, validated as input } from '../../../../shared/http/validate.ts';
import { logger } from '../../../../shared/logger.ts';
import { approvePayment, type Caller, getPayment, listBankMatching, listPayments, matchBank, resolvePayment } from '../service/payments.ts';
import { listSettlementRuns, openRun, processRun, runView } from '../service/settlement-runs.ts';
import type { FinanceContext } from '../service/settlement-views.ts';
import { canSeeCost, financeView } from './access.ts';
import {
  BankMatchBody,
  BankMatchingQuery,
  EntryIdParams,
  OrderIdParams,
  PaymentListQuery,
  ResolveBody,
  RunBody,
  RunListQuery,
} from './payment-schemas.ts';
import { VersionBody } from './schemas.ts';

const caller = (res: Response): Caller => {
  const { companyId, accountId } = getAuth(res);
  const { permissions, enabledModules } = getAccess(res);
  return { companyId: companyId!, accountId, permissions, enabledModules };
};
const orderId = (res: Response) => input<typeof OrderIdParams>(res, 'params').orderId;

/** Trạng thái tiền của đơn, đối soát, khớp sao kê (Documents/21 §21.2, §21.3; #117), gắn vào router của finance. */
export function mountPaymentRoutes(router: Router, ctx: FinanceContext): void {
  const view = financeView(ctx);
  const resolve = ctx.authorize('finance.settlement.resolve');
  const approve = ctx.authorize('finance.settlement.approve');

  router.get('/payments', view, validate({ query: PaymentListQuery }), async (_req, res) => {
    res.json(await listPayments(caller(res).companyId, input<typeof PaymentListQuery>(res, 'query')));
  });
  router.get('/payments/:orderId', view, validate({ params: OrderIdParams }), async (_req, res) => {
    res.json(await getPayment(caller(res).companyId, orderId(res), canSeeCost(res)));
  });
  router.post('/payments/:orderId/resolve', resolve, validate({ params: OrderIdParams, body: ResolveBody }), async (_req, res) => {
    res.json(await resolvePayment(caller(res), orderId(res), input<typeof ResolveBody>(res, 'body'), canSeeCost(res)));
  });
  router.post('/payments/:orderId/ceo-approve', approve, validate({ params: OrderIdParams, body: VersionBody }), async (_req, res) => {
    res.json(await approvePayment(caller(res), orderId(res), input<typeof VersionBody>(res, 'body'), canSeeCost(res)));
  });

  router.get('/settlement-runs', view, validate({ query: RunListQuery }), async (_req, res) => {
    res.json(await listSettlementRuns(caller(res).companyId, input<typeof RunListQuery>(res, 'query')));
  });
  // R12: trả 202 với lần chạy `running`, phần gọi sàn và ghi sổ chạy tiếp ở nền; xem kết quả ở GET /settlement-runs.
  router.post('/settlement-runs', resolve, validate({ body: RunBody }), async (_req, res) => {
    const { shopId, fileId } = input<typeof RunBody>(res, 'body');
    if (fileId) throw new AppError(422, 'file_import_unsupported', 'Đối soát bằng tệp báo cáo của sàn chưa hỗ trợ');
    const { companyId, accountId } = caller(res);
    const run = await openRun(ctx, companyId, accountId, shopId);
    res.status(202).json(runView(run));
    processRun(ctx, companyId, run.id).catch((err: unknown) => logger.error({ err, runId: run.id }, 'đối soát chạy nền lỗi'));
  });

  router.get('/bank-matching', view, validate({ query: BankMatchingQuery }), async (_req, res) => {
    res.json(await listBankMatching(caller(res).companyId, input<typeof BankMatchingQuery>(res, 'query')));
  });
  router.post('/ledger/:id/bank-match', resolve, validate({ params: EntryIdParams, body: BankMatchBody }), async (_req, res) => {
    res.json(await matchBank(caller(res), input<typeof EntryIdParams>(res, 'params').id, input<typeof BankMatchBody>(res, 'body').bankRef));
  });
}
