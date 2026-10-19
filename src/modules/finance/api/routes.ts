import { type Response, Router } from 'express';
import type { z } from 'zod';
import { getAuth } from '../../../shared/auth/authenticate.ts';
import { validate } from '../../../shared/http/validate.ts';
import type { ModuleContext } from '../../../shared/module.ts';
import { confirmCod, listCodOrders } from '../service/cod.ts';
import { getInvoice, getReceipt, listInvoices, listReceipts } from '../service/documents.ts';
import {
  createVoucher,
  deleteDraft,
  getVoucher,
  listRefunds,
  listVouchers,
  postVoucher,
  refundOrder,
  updateDraft,
} from '../service/payment-vouchers.ts';
import {
  CodConfirmationBody,
  CodListQuery,
  CreateVoucherBody,
  IdParams,
  InvoiceListQuery,
  ReceiptListQuery,
  RefundBody,
  RefundListQuery,
  UpdateVoucherBody,
  VersionBody,
  VersionQuery,
  VoucherListQuery,
} from './schemas.ts';

type Part = 'body' | 'query' | 'params';
const input = <S extends z.ZodType>(res: Response, part: Part) => (res.locals.validated as Record<Part, unknown>)[part] as z.output<S>;
const caller = (res: Response) => {
  const { companyId, accountId } = getAuth(res);
  return { companyId: companyId!, accountId };
};
const id = (res: Response) => input<typeof IdParams>(res, 'params').id;

/**
 * Route của module `finance`, gắn tại /api/v1/finance (Documents/21 §12.5). Xem: `finance.invoice.view`; ghi tiền:
 * `finance.voucher.create` (T7). Kiểm quyền trước kiểm dữ liệu.
 */
export function financeRouter(ctx: ModuleContext): Router {
  const router = Router();
  const view = ctx.authorize('finance.invoice.view');
  const write = ctx.authorize('finance.voucher.create');

  router.get('/invoices', view, validate({ query: InvoiceListQuery }), async (_req, res) => {
    res.json(await listInvoices(caller(res).companyId, input<typeof InvoiceListQuery>(res, 'query')));
  });
  router.get('/invoices/:id', view, validate({ params: IdParams }), async (_req, res) => {
    res.json(await getInvoice(caller(res).companyId, id(res)));
  });
  router.get('/receipts', view, validate({ query: ReceiptListQuery }), async (_req, res) => {
    res.json(await listReceipts(caller(res).companyId, input<typeof ReceiptListQuery>(res, 'query')));
  });
  router.get('/receipts/:id', view, validate({ params: IdParams }), async (_req, res) => {
    res.json(await getReceipt(caller(res).companyId, id(res)));
  });

  router.get('/payment-vouchers', view, validate({ query: VoucherListQuery }), async (_req, res) => {
    res.json(await listVouchers(caller(res).companyId, input<typeof VoucherListQuery>(res, 'query')));
  });
  router.get('/payment-vouchers/:id', view, validate({ params: IdParams }), async (_req, res) => {
    res.json(await getVoucher(caller(res).companyId, id(res)));
  });
  router.post('/payment-vouchers', write, validate({ body: CreateVoucherBody }), async (_req, res) => {
    res.status(201).json(await createVoucher(caller(res), input<typeof CreateVoucherBody>(res, 'body')));
  });
  router.put('/payment-vouchers/:id', write, validate({ params: IdParams, body: UpdateVoucherBody }), async (_req, res) => {
    res.json(await updateDraft(caller(res), id(res), input<typeof UpdateVoucherBody>(res, 'body')));
  });
  router.delete('/payment-vouchers/:id', write, validate({ params: IdParams, query: VersionQuery }), async (_req, res) => {
    await deleteDraft(caller(res), id(res), input<typeof VersionQuery>(res, 'query').version);
    res.status(204).end();
  });
  router.post('/payment-vouchers/:id/post', write, validate({ params: IdParams, body: VersionBody }), async (_req, res) => {
    res.json(await postVoucher(caller(res), id(res), input<typeof VersionBody>(res, 'body').version));
  });

  router.get('/cod-orders', view, validate({ query: CodListQuery }), async (_req, res) => {
    res.json(await listCodOrders(caller(res).companyId, input<typeof CodListQuery>(res, 'query')));
  });
  router.post('/cod-confirmations', write, validate({ body: CodConfirmationBody }), async (_req, res) => {
    res.json(await confirmCod(caller(res), input<typeof CodConfirmationBody>(res, 'body').orderIds));
  });

  router.get('/refunds', view, validate({ query: RefundListQuery }), async (_req, res) => {
    res.json(await listRefunds(caller(res).companyId, input<typeof RefundListQuery>(res, 'query')));
  });
  router.post('/refunds', write, validate({ body: RefundBody }), async (_req, res) => {
    res.status(201).json(await refundOrder(caller(res), input<typeof RefundBody>(res, 'body')));
  });

  return router;
}
