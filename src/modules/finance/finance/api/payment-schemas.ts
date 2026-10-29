import { z } from 'zod';
import { SETTLEMENT_STATES } from '../domain/settlement.ts';
import { LedgerLine } from './ledger-schemas.ts';
import { page, VersionBody } from './schemas.ts';

// Trạng thái tiền của đơn, đối soát, khớp sao kê (Documents/21 §21.2, §21.3; #117). Tiền là số nguyên đồng (R2).

const status = z.enum(SETTLEMENT_STATES, 'Trạng thái tiền không hợp lệ');
const paging = { page: page.page, pageSize: page.pageSize };
const UserRef = z.object({ id: z.uuid(), name: z.string() });

export const PaymentListQuery = z.object({ ...paging, status: status.optional(), shopId: z.uuid('Gian hàng không hợp lệ').optional() });
export const OrderIdParams = z.object({ orderId: z.string() });
export const ResolveBody = z
  .object({
    version: VersionBody.shape.version,
    reason: z.string('Cần ghi lý do').trim().min(1, 'Cần ghi lý do').max(500, 'Lý do tối đa 500 ký tự'),
  })
  .meta({ id: 'PaymentResolveRequest' });

export const RunListQuery = z.object({ ...paging, shopId: z.uuid('Gian hàng không hợp lệ').optional() });
export const RunBody = z
  .object({
    shopId: z.uuid('Gian hàng không hợp lệ'),
    fileId: z.uuid('Tệp không hợp lệ').optional().meta({ description: 'Tệp báo cáo khi gian hàng đã ngắt: chưa hỗ trợ (422)' }),
  })
  .meta({ id: 'SettlementRunRequest' });

export const BankMatchingQuery = z.object({
  ...paging,
  kind: z.enum(['withdrawal', 'supplier_refund', 'lost_compensation'], 'Loại là withdrawal, supplier_refund hoặc lost_compensation').optional(),
  matched: z
    .enum(['true', 'false'], 'matched là true hoặc false')
    .transform((v) => v === 'true')
    .optional(),
});
export const EntryIdParams = z.object({ id: z.string() });
export const BankMatchBody = z
  .object({ bankRef: z.string('Cần mã giao dịch ngân hàng').trim().min(1, 'Cần mã giao dịch ngân hàng').max(100, 'Tối đa 100 ký tự') })
  .meta({ id: 'BankMatchRequest' });

export const OrderPayment = z
  .object({
    orderId: z.uuid(),
    orderCode: z.string().nullable(),
    shopId: z.uuid().nullable(),
    status,
    estimatedTotal: z.number(),
    settledTotal: z.number().nullable(),
    diff: z.number().nullable(),
    threshold: z.object({ abs: z.number(), pct: z.number(), resolveLimit: z.number() }),
    needsCeoApproval: z.boolean(),
    ceoApproval: z.object({ by: UserRef.nullable(), at: z.iso.datetime() }).nullable(),
    resolved: z.object({ by: UserRef.nullable(), at: z.iso.datetime().nullable(), reason: z.string().nullable() }).nullable(),
    feeConfigAuthor: UserRef.nullable(),
    version: z.int(),
  })
  .meta({ id: 'OrderPayment' });

const StatusChange = z.object({
  at: z.iso.datetime(),
  from: z.string().nullable(),
  to: z.string(),
  by: UserRef.nullable(),
  source: z.enum(['user', 'marketplace', 'system']),
  reason: z.string().nullable(),
});

export const OrderPaymentDetail = OrderPayment.extend({ statusHistory: z.array(StatusChange), lines: z.array(LedgerLine) }).meta({
  id: 'OrderPaymentDetail',
});

export const OrderPaymentPage = z
  .object({
    items: z.array(OrderPayment),
    total: z.int(),
    page: z.int(),
    pageSize: z.int(),
    counts: z.record(status, z.int()),
  })
  .meta({ id: 'OrderPaymentPage' });

export const SettlementRun = z
  .object({
    id: z.uuid(),
    shopId: z.uuid(),
    source: z.enum(['api', 'file']),
    fileId: z.uuid().nullable(),
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    status: z.enum(['running', 'done', 'failed']),
    lineCount: z.int(),
    duplicates: z.int(),
    walletDiff: z.number().nullable().meta({ description: 'Số dư sàn báo trừ số dư theo sổ; khác 0 là lệch ví' }),
    error: z.string().nullable(),
    createdBy: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'SettlementRun' });

export const SettlementRunPage = z
  .object({ items: z.array(SettlementRun), total: z.int(), page: z.int(), pageSize: z.int() })
  .meta({ id: 'SettlementRunPage' });

export const LedgerLinePage = z
  .object({ items: z.array(LedgerLine), total: z.int(), page: z.int(), pageSize: z.int() })
  .meta({ id: 'LedgerLinePage' });
