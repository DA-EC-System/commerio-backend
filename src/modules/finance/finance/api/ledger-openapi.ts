import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { problemResponse } from '../../../../shared/http/openapi.ts';
import { LedgerListQuery, LedgerPage, OrderIdParams, OrderProfit, OrderProfitPage, OrderProfitsQuery, SkuProfitPage, SkuProfitsQuery, TaxWarnings } from './ledger-schemas.ts';

const json = <T>(schema: T) => ({ content: { 'application/json': { schema } } });
const bearer = [{ bearerAuth: [] }];
const auth = {
  401: problemResponse('`unauthorized`'),
  403: problemResponse('`company_not_selected`, `company_locked`, `account_locked`, `module_disabled`, `forbidden`'),
};
const VIEW = 'Cần một trong `finance.config.*`, `finance.settlement.*`, `finance.invoice.view`. Dòng giá vốn và `cogs`, `gross` chỉ có khi có `inventory.cost.view`.';

/** Swagger của sổ tiền (Documents/21 §21.1; #116), tương đối với /api/v1/finance. */
export function registerLedgerOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/ledger',
    summary: 'Sổ tiền: mỗi khoản một dòng, ước tính hoặc thực tế, kèm tổng theo chỗ tiền',
    description: `${VIEW} \`from\`, \`to\` lọc theo \`occurredOn\` (gồm cả hai ngày).`,
    security: bearer,
    request: { query: LedgerListQuery },
    responses: {
      200: { description: 'Trang sổ', ...json(LedgerPage) },
      ...auth,
      422: problemResponse('`validation_failed` kèm `errors` theo ô'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/orders/profits',
    summary: 'Lãi theo danh sách đơn: thực nhận, giá vốn, lãi gộp của phần đã giao trong kỳ giao',
    description: `${VIEW} \`from\`, \`to\` lọc theo ngày kiện đầu tiên của đơn giao xong (giờ Việt Nam, gồm cả hai ngày). \`totals\` tính trên toàn bộ kết quả lọc. \`estimated\` tới khi đơn có số quyết toán.`,
    security: bearer,
    request: { query: OrderProfitsQuery },
    responses: {
      200: { description: 'Trang lãi theo đơn', ...json(OrderProfitPage) },
      ...auth,
      422: problemResponse('`validation_failed` kèm `errors` theo ô'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/skus/profits',
    summary: 'Lãi theo SKU: số bán, thực nhận, giá vốn, lãi gộp của dòng hàng đã giao trong kỳ',
    description: `${VIEW} \`from\`, \`to\` lọc theo ngày giao của dòng hàng (giờ Việt Nam, gồm cả hai ngày). Thực nhận của đơn (gồm phí, ship, hoàn tiền) chia cho dòng hàng theo tỷ lệ doanh thu; giá vốn theo dòng. \`totals\` tính trên toàn bộ kết quả lọc.`,
    security: bearer,
    request: { query: SkuProfitsQuery },
    responses: {
      200: { description: 'Trang lãi theo SKU', ...json(SkuProfitPage) },
      ...auth,
      422: problemResponse('`validation_failed` kèm `errors` theo ô'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/orders/:orderId/profit',
    summary: 'Lãi theo đơn: thực nhận, giá vốn, lãi gộp của phần đã giao',
    description: VIEW,
    security: bearer,
    request: { params: OrderIdParams },
    responses: {
      200: { description: 'Lãi của đơn', ...json(OrderProfit) },
      ...auth,
      404: problemResponse('`not_found`: đơn không có hoặc của công ty khác'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/tax-warnings',
    summary: 'Luỹ kế doanh thu năm so với mốc của quy tắc thuế đang áp (cảnh báo từ 90%)',
    description: VIEW,
    security: bearer,
    responses: { 200: { description: 'Cảnh báo mốc thuế', ...json(TaxWarnings) }, ...auth },
  });
}
