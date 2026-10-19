import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import type { z } from 'zod';
import { problemResponse } from '../../../shared/http/openapi.ts';
import {
  CodConfirmationBody,
  CodConfirmationResult,
  CodListQuery,
  CodPage,
  CreateVoucherBody,
  IdParams,
  Invoice,
  InvoiceListQuery,
  InvoicePage,
  PaymentVoucher,
  Receipt,
  ReceiptListQuery,
  ReceiptPage,
  RefundBody,
  RefundListQuery,
  RefundPage,
  UpdateVoucherBody,
  VersionBody,
  VersionQuery,
  VoucherListQuery,
  VoucherPage,
} from './schemas.ts';

const json = <T>(schema: T) => ({ content: { 'application/json': { schema } } });
const bearer = [{ bearerAuth: [] }];
const auth = {
  401: problemResponse('`unauthorized`'),
  403: problemResponse('`company_not_selected`, `company_locked`, `account_locked`, `forbidden`'),
};
const VIEW = 'Cần `finance.invoice.view`.';
const WRITE = 'Cần `finance.voucher.create`.';
const notFound = (what: string) => problemResponse(`\`not_found\`: ${what} không có hoặc của công ty khác`);
const invalid = problemResponse('`validation_failed` kèm `errors` theo ô');

/** Đường dẫn Swagger của module `finance`, viết tương đối với /api/v1/finance (Documents/21 §12.5). */
export function registerFinanceOpenApi(registry: OpenAPIRegistry): void {
  const get = (path: string, summary: string, query: z.ZodObject | undefined, ok: z.ZodType, extra = {}) =>
    registry.registerPath({
      method: 'get',
      path,
      summary,
      description: VIEW,
      security: bearer,
      request: query ? { query } : { params: IdParams },
      responses: { 200: { description: summary, ...json(ok) }, ...auth, ...extra },
    });

  get('/invoices', 'Hoá đơn bán (tự sinh khi xuất kho)', InvoiceListQuery, InvoicePage, { 422: invalid });
  get('/invoices/:id', 'Một hoá đơn kèm dòng hàng', undefined, Invoice, { 404: notFound('hoá đơn') });
  get('/receipts', 'Phiếu thu', ReceiptListQuery, ReceiptPage, { 422: invalid });
  get('/receipts/:id', 'Một phiếu thu', undefined, Receipt, { 404: notFound('phiếu thu') });
  get('/payment-vouchers', 'Phiếu chi (lọc `from`/`to` theo `paidOn`)', VoucherListQuery, VoucherPage, { 422: invalid });
  get('/payment-vouchers/:id', 'Một phiếu chi', undefined, PaymentVoucher, { 404: notFound('phiếu chi') });
  get('/cod-orders', 'Đơn COD (mặc định `cod_pending` đã giao; `from`/`to` theo ngày giao)', CodListQuery, CodPage, { 422: invalid });
  get('/refunds', 'Đơn cần hoàn tiền (mặc định `pending_refund`)', RefundListQuery, RefundPage, { 422: invalid });

  registry.registerPath({
    method: 'post',
    path: '/payment-vouchers',
    summary: 'Lập phiếu chi nháp (UC-PF-05)',
    description: `${WRITE} Đúng một chứng từ gốc theo \`purpose\`; số tiền bằng số phải chi (T19). \`supplier_payment\` chưa làm (422).`,
    security: bearer,
    request: { body: json(CreateVoucherBody) },
    responses: {
      201: { description: 'Phiếu chi nháp', ...json(PaymentVoucher) },
      ...auth,
      422: problemResponse('`errors.purpose`, `errors.orderId`, `errors.unmatchedReceiptId`, `errors.amount`, `errors.paidOn`, `errors.note`'),
    },
  });
  registry.registerPath({
    method: 'put',
    path: '/payment-vouchers/:id',
    summary: 'Sửa phiếu chi nháp',
    description: WRITE,
    security: bearer,
    request: { params: IdParams, body: json(UpdateVoucherBody) },
    responses: {
      200: { description: 'Phiếu chi sau khi sửa', ...json(PaymentVoucher) },
      ...auth,
      404: notFound('phiếu chi'),
      409: problemResponse('`version_conflict` kèm `current`; `not_draft`'),
      422: invalid,
    },
  });
  registry.registerPath({
    method: 'delete',
    path: '/payment-vouchers/:id',
    summary: 'Xoá phiếu chi nháp',
    description: `${WRITE} Gửi \`?version=\` (V8).`,
    security: bearer,
    request: { params: IdParams, query: VersionQuery },
    responses: {
      204: { description: 'Đã xoá' },
      ...auth,
      404: notFound('phiếu chi'),
      409: problemResponse('`version_conflict` kèm `current`; `not_draft`'),
      422: problemResponse('`errors.version`'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/payment-vouchers/:id/post',
    summary: 'Ghi sổ phiếu chi',
    description: `${WRITE} Cùng giao dịch: đơn → \`refunded\`, khoản thu chưa khớp → \`refunded\`.`,
    security: bearer,
    request: { params: IdParams, body: json(VersionBody) },
    responses: {
      200: { description: 'Phiếu chi đã ghi sổ', ...json(PaymentVoucher) },
      ...auth,
      404: notFound('phiếu chi'),
      409: problemResponse('`not_draft`; `version_conflict` kèm `current`; `already_processed` (nêu số phiếu đã có); `payment_state_changed` kèm `current: OrderPayment`'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/cod-confirmations',
    summary: 'Xác nhận đã nhận tiền COD theo lô (UC-PF-04, T18)',
    description: `${WRITE} Tất cả hoặc không gì: mọi đơn phải \`cod_pending\` và đã giao. Mỗi đơn một phiếu thu \`cod\` = tổng đơn.`,
    security: bearer,
    request: { body: json(CodConfirmationBody) },
    responses: {
      200: { description: 'Phiếu thu của từng đơn', ...json(CodConfirmationResult) },
      ...auth,
      404: notFound('đơn'),
      409: problemResponse('`payment_state_changed` kèm `orders: [{ orderId, code, status }]` các đơn lệch; cả lô không đổi'),
      422: problemResponse('`errors.orderIds`'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/refunds',
    summary: 'Hoàn tiền một bước cho đơn đã thu bị huỷ (UC-PF-06, T20)',
    description: `${WRITE} Lập và ghi sổ phiếu chi \`customer_refund\` = số đã thu; đơn → \`refunded\`.`,
    security: bearer,
    request: { body: json(RefundBody) },
    responses: {
      201: { description: 'Phiếu chi đã ghi sổ', ...json(PaymentVoucher) },
      ...auth,
      404: notFound('đơn'),
      409: problemResponse('`already_processed` (đơn vừa được hoàn, nêu số phiếu); `payment_state_changed` kèm `current: OrderPayment`'),
      422: invalid,
    },
  });
}
