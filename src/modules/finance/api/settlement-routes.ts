import type { RequestHandler, Response, Router } from 'express';
import { getAuth } from '../../../shared/auth/authenticate.ts';
import { getAccess } from '../../../shared/auth/authorize.ts';
import { env } from '../../../shared/config/env.ts';
import { AppError } from '../../../shared/errors/app-error.ts';
import { validate, validated as input } from '../../../shared/http/validate.ts';
import {
  type FinanceContext,
  getSettlement,
  importSettlement,
  listSettlementLines,
  listSettlements,
} from '../service/settlement-views.ts';
import { IdParams } from './schemas.ts';
import { SettlementImportBody, SettlementLineListQuery, SettlementListQuery } from './settlement-schemas.ts';

const companyOf = (res: Response) => getAuth(res).companyId!;

/**
 * Đối soát cần phân hệ Kênh bán (§12.6, M4). `authorize` chỉ kiểm phân hệ của mã quyền (`finance`), nên kiểm thêm ở
 * đây, sau `authorize` (401, 403 quyền trước), trước `validate()` (403 trước 422) (plan #30 A8).
 */
const channelEnabled: RequestHandler = (_req, res, next) => {
  if (!getAccess(res).enabledModules.includes('channel'))
    throw new AppError(403, 'module_disabled', 'Phân hệ Kênh bán đang tắt');
  next();
};

/** Route đối soát tiền sàn (Documents/21 §12.6; plan #30), gắn vào router của finance. */
export function mountSettlementRoutes(router: Router, ctx: FinanceContext): void {
  const view = [ctx.authorize('finance.invoice.view'), channelEnabled];
  const write = [ctx.authorize('finance.voucher.create'), channelEnabled];

  router.get('/settlements', ...view, validate({ query: SettlementListQuery }), async (_req, res) => {
    res.json(await listSettlements(ctx, companyOf(res), input<typeof SettlementListQuery>(res, 'query')));
  });
  router.get('/settlements/:id', ...view, validate({ params: IdParams }), async (_req, res) => {
    res.json(await getSettlement(ctx, companyOf(res), input<typeof IdParams>(res, 'params').id));
  });
  router.get('/settlement-lines', ...view, validate({ query: SettlementLineListQuery }), async (_req, res) => {
    res.json(await listSettlementLines(companyOf(res), input<typeof SettlementLineListQuery>(res, 'query')));
  });

  // Nhận bảng kê khuôn OAS cho demo/E2E khi chưa có sàn giả lập (plan #30 A2): không gắn ở production.
  if (env.NODE_ENV !== 'production') {
    router.post('/settlements/dev/import', ...write, validate({ body: SettlementImportBody }), async (_req, res) => {
      const { created, statement } = await importSettlement(
        ctx,
        companyOf(res),
        input<typeof SettlementImportBody>(res, 'body'),
      );
      res.status(created ? 201 : 200).json(statement);
    });
  }
}
