import type { OpenAPIRegistry, RouteConfig } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { problemResponse } from '../../../shared/http/openapi.ts';
import { DailyQuery, DailyResponse, ExportQuery, OverviewResponse, RangeQuery, ShopsResponse } from './schemas.ts';

const json = (description: string, schema: z.ZodType) => ({ description, content: { 'application/json': { schema } } });

const common = {
  401: problemResponse('Chưa đăng nhập'),
  403: problemResponse(
    'Chưa chọn công ty, công ty hoặc tài khoản bị khoá, phân hệ Report tắt (`module_disabled`), hoặc thiếu `report.dashboard.view` / `finance.invoice.view` (`forbidden`)',
  ),
  422: problemResponse('Ngày sai dạng, `from` sau `to`, khoảng quá 366 ngày, nguồn hay gian hàng sai (`validation_failed`, `errors` theo ô)'),
};
const RANGE_NOTE =
  '`from`, `to` theo giờ VN; mặc định 30 ngày tới hôm nay, chỉ có `from` thì tới hôm nay, chỉ có `to` thì 30 ngày tới `to`, tối đa 366 ngày. `cogs`, `profit` là `null` khi thiếu `inventory.cost.view`.';

/** Đường dẫn Swagger của module `report`, tương đối với /api/v1/report (Documents/21 §12.7). */
export function registerReportOpenApi(registry: OpenAPIRegistry): void {
  const path = (route: RouteConfig) =>
    registry.registerPath({ ...route, description: RANGE_NOTE, responses: { ...common, ...route.responses } });

  path({
    method: 'get',
    path: '/overview',
    summary: 'Tổng quan doanh thu, tiền đã thu, phí, giá vốn, lãi của công ty',
    request: { query: RangeQuery },
    responses: { 200: json('Số của cả công ty trong khoảng', OverviewResponse) },
  });
  path({
    method: 'get',
    path: '/shops',
    summary: 'Lãi theo gian hàng sàn và theo nguồn (hộp thư, đơn tạo tay)',
    request: { query: RangeQuery },
    responses: { 200: json('Một dòng mỗi gian hàng / nguồn có số, kèm tổng', ShopsResponse) },
  });
  path({
    method: 'get',
    path: '/daily',
    summary: 'Chuỗi theo ngày, đủ mọi ngày trong khoảng (ngày không có số trả 0)',
    request: { query: DailyQuery },
    responses: { 200: json('Số theo ngày', DailyResponse) },
  });
  path({
    method: 'get',
    path: '/export',
    summary: 'Xuất CSV (cần thêm `report.dashboard.export`)',
    request: { query: ExportQuery },
    responses: {
      200: {
        description:
          'CSV UTF-8 có BOM, `Content-Disposition: attachment; filename="bao-cao-<report>-<from>-<to>.csv"`; thiếu `inventory.cost.view` thì không có cột Giá vốn, Lãi',
        content: { 'text/csv': { schema: z.string() } },
      },
    },
  });
}
