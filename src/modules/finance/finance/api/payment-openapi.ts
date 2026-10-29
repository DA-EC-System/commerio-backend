import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { problemResponse } from '../../../../shared/http/openapi.ts';
import { LedgerLine } from './ledger-schemas.ts';
import {
  BankMatchBody,
  BankMatchingQuery,
  EntryIdParams,
  LedgerLinePage,
  OrderIdParams,
  OrderPaymentDetail,
  OrderPaymentPage,
  PaymentListQuery,
  ResolveBody,
  RunBody,
  RunListQuery,
  SettlementRun,
  SettlementRunPage,
} from './payment-schemas.ts';
import { VersionBody } from './schemas.ts';

const json = <T>(schema: T) => ({ content: { 'application/json': { schema } } });
const bearer = [{ bearerAuth: [] }];
const auth = {
  401: problemResponse('`unauthorized`'),
  403: problemResponse('`company_not_selected`, `company_locked`, `account_locked`, `module_disabled`, `forbidden`'),
};
const VIEW = 'Cần một trong `finance.config.*`, `finance.settlement.*`, `finance.invoice.view`.';
const notFound = (what: string) => problemResponse(`\`not_found\`: ${what} không có hoặc của công ty khác`);

/** Swagger của trạng thái tiền, đối soát, khớp sao kê (Documents/21 §21.2, §21.3; #117), tương đối với /api/v1/finance. */
export function registerPaymentOpenApi(registry: OpenAPIRegistry): void {
  const path = (method: 'get' | 'post', p: string, summary: string, description: string, request: object, responses: object) =>
    registry.registerPath({ method, path: p, summary, description, security: bearer, request, responses: { ...auth, ...responses } });

  path('get', '/payments', 'Trạng thái tiền của đơn sàn', VIEW, { query: PaymentListQuery }, { 200: { description: 'Trang', ...json(OrderPaymentPage) } });
  path('get', '/payments/:orderId', 'Trạng thái tiền của một đơn kèm dòng sổ, lịch sử', VIEW, { params: OrderIdParams }, {
    200: { description: 'Chi tiết', ...json(OrderPaymentDetail) },
    404: notFound('trạng thái tiền của đơn'),
  });
  path(
    'post',
    '/payments/:orderId/resolve',
    'Chốt lệch quyết toán',
    'Cần `finance.settlement.resolve`; người chốt khác người soạn cấu hình phí của gian hàng; lệch vượt hạn mức tự chốt thì cần CEO duyệt trước (CEO tự chốt được).',
    { params: OrderIdParams, body: json(ResolveBody) },
    {
      200: { description: 'Đã chốt', ...json(OrderPaymentDetail) },
      404: notFound('trạng thái tiền của đơn'),
      409: problemResponse('`invalid_transition` kèm `current`; `second_person_required`; `ceo_approval_required`; `version_conflict`'),
      422: problemResponse('`reason_required`; `validation_failed`'),
    },
  );
  path('post', '/payments/:orderId/ceo-approve', 'CEO duyệt chốt lệch vượt hạn mức', 'Cần `finance.settlement.approve`. Không đổi trạng thái.', { params: OrderIdParams, body: json(VersionBody) }, {
    200: { description: 'Đã duyệt', ...json(OrderPaymentDetail) },
    404: notFound('trạng thái tiền của đơn'),
    409: problemResponse('`invalid_transition` (không ở `mismatch`); `approval_not_needed`; `version_conflict`'),
  });
  path('get', '/settlement-runs', 'Các lần kéo quyết toán', VIEW, { query: RunListQuery }, { 200: { description: 'Trang', ...json(SettlementRunPage) } });
  path(
    'post',
    '/settlement-runs',
    'Kéo quyết toán của gian hàng',
    'Cần `finance.settlement.resolve`. Trả 202 với lần chạy `running` (R12); kỳ từ cuối lần `done` gần nhất tới bây giờ; chạy lại không ghi trùng.',
    { body: json(RunBody) },
    {
      202: { description: 'Đang chạy', ...json(SettlementRun) },
      404: notFound('gian hàng'),
      409: problemResponse('`settlement_running`'),
      422: problemResponse('`marketplace_unsupported`; `file_import_unsupported`; `validation_failed`'),
    },
  );
  path('get', '/bank-matching', 'Khoản cần khớp sao kê ngân hàng (rút tiền, NCC hoàn, bồi thường)', VIEW, { query: BankMatchingQuery }, {
    200: { description: 'Trang dòng sổ', ...json(LedgerLinePage) },
  });
  path('post', '/ledger/:id/bank-match', 'Khớp dòng sổ với sao kê ngân hàng', 'Cần `finance.settlement.resolve`.', { params: EntryIdParams, body: json(BankMatchBody) }, {
    200: { description: 'Dòng sổ đã khớp', ...json(LedgerLine) },
    404: notFound('dòng sổ'),
    409: problemResponse('`already_matched`'),
    422: problemResponse('`not_bank_matchable`; `validation_failed`'),
  });
}
