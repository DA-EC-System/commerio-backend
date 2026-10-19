import { type Response, Router } from 'express';
import type { z } from 'zod';
import { getAuth } from '../../../shared/auth/authenticate.ts';
import { getAccess } from '../../../shared/auth/authorize.ts';
import { AppError } from '../../../shared/errors/app-error.ts';
import { validate, validated } from '../../../shared/http/validate.ts';
import type { ModuleContext } from '../../../shared/module.ts';
import { figuresCsv, sourceLabel } from '../domain/csv.ts';
import { vnDay } from '../domain/days.ts';
import { resolveRange } from '../domain/figures.ts';
import * as reports from '../service/queries.ts';
import { DailyQuery, ExportQuery, RangeQuery } from './schemas.ts';

type Query = z.output<typeof ExportQuery>;
// Mỗi route một schema query; đọc chung qua dạng rộng nhất (ExportQuery), trường không có thì trống.
const queryOf = (res: Response): Partial<Query> => validated<typeof ExportQuery>(res, 'query');
const invalid = (errors: Record<string, string>) =>
  new AppError(422, 'validation_failed', 'Dữ liệu gửi lên không hợp lệ', { errors });

function rangeOf(res: Response): reports.Range {
  const range = resolveRange(queryOf(res), vnDay(new Date()));
  if ('errors' in range) throw invalid(range.errors);
  return range;
}

/** `shopId` chỉ đi với nguồn sàn; bỏ trống nguồn thì hiểu là sàn (plan #29 A10). */
function filterOf(res: Response) {
  const { source, shopId } = queryOf(res);
  if (shopId && source && source !== 'marketplace') throw invalid({ shopId: 'Gian hàng chỉ đi với nguồn marketplace' });
  return shopId ? { shopId, source: 'marketplace' as const } : source ? { source } : {};
}

/** Quyền giá vốn từ lần đọc DB của `authorize` trong request này (D1): thu quyền thì lần gọi sau thấy `null` ngay. */
function viewerOf(res: Response): reports.Viewer {
  return { companyId: getAuth(res).companyId!, canCost: getAccess(res).permissions.includes('inventory.cost.view') };
}

/** Route của module `report`, gắn tại /api/v1/report (Documents/21 §12.7). */
export function reportRouter(ctx: ModuleContext): Router {
  const router = Router();
  // `report.dashboard.view` đứng đầu: phân hệ Report tắt thì 403 `module_disabled` trước `forbidden`.
  const view = [ctx.authorize('report.dashboard.view'), ctx.authorize('finance.invoice.view')];

  router.get('/overview', ...view, validate({ query: RangeQuery }), async (_req, res) => {
    const range = rangeOf(res);
    res.json(await reports.overview(viewerOf(res), range));
  });

  router.get('/shops', ...view, validate({ query: RangeQuery }), async (_req, res) => {
    const range = rangeOf(res);
    res.json(await reports.byShop(viewerOf(res), range));
  });

  router.get('/daily', ...view, validate({ query: DailyQuery }), async (_req, res) => {
    const range = rangeOf(res);
    const filter = filterOf(res);
    res.json(await reports.daily(viewerOf(res), range, filter));
  });

  router.get('/export', ...view, ctx.authorize('report.dashboard.export'), validate({ query: ExportQuery }), async (_req, res) => {
    const range = rangeOf(res);
    const viewer = viewerOf(res);
    const report = queryOf(res).report!;
    let csv: Buffer;
    if (report === 'overview') {
      const o = await reports.overview(viewer, range);
      csv = figuresCsv([['Từ ngày', () => o.from], ['Đến ngày', () => o.to]], [o], viewer.canCost);
    } else if (report === 'shops') {
      const s = await reports.byShop(viewer, range);
      csv = figuresCsv(
        [
          ['Nguồn', (r) => sourceLabel(r.source)],
          ['Sàn', (r) => r.shop?.platform ?? null],
          ['Gian hàng', (r) => r.shop?.shopName ?? null],
        ],
        s.items,
        viewer.canCost,
        { label: 'Tổng', figures: s.total },
      );
    } else {
      const d = await reports.daily(viewer, range, filterOf(res));
      csv = figuresCsv([['Ngày', (r) => r.day]], d.items, viewer.canCost);
    }
    res
      .type('text/csv; charset=utf-8')
      // Tên tệp trong ngoặc kép đúng như §12.7 (`attachment()` của Express bỏ ngoặc kép với tên ASCII).
      .set('Content-Disposition', `attachment; filename="bao-cao-${report}-${range.from}-${range.to}.csv"`)
      .send(csv);
  });

  return router;
}
