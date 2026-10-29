import { z } from 'zod';
import { LEDGER_KINDS } from '../domain/ledger.ts';
import { page } from './schemas.ts';

// Hợp đồng sổ tiền (Documents/21 §21.1; #116). Tiền là số nguyên đồng (R2), có dấu: vào dương, ra âm.

const day = (label: string) => z.iso.date(`${label} dạng yyyy-mm-dd`);
const kind = z.enum(LEDGER_KINDS, 'Loại khoản không hợp lệ');

export const LedgerListQuery = z.object({
  page: page.page,
  pageSize: page.pageSize,
  filter: z.enum(['all', 'estimated', 'actual', 'replaced'], 'Lọc là all, estimated, actual hoặc replaced').default('all'),
  kind: kind.optional(),
  shopId: z.uuid('Gian hàng không hợp lệ').optional(),
  orderId: z.uuid('Đơn không hợp lệ').optional(),
  from: day('Từ ngày').optional(),
  to: day('Đến ngày').optional(),
});

export const OrderIdParams = z.object({ orderId: z.string() });

export const LedgerLine = z
  .object({
    id: z.uuid(),
    kind,
    amount: z.number(),
    estimated: z.boolean(),
    replacesId: z.uuid().nullable(),
    replacedBy: z.uuid().nullable(),
    occurredOn: z.iso.date(),
    shopId: z.uuid().nullable(),
    orderId: z.uuid().nullable(),
    orderCode: z.string().nullable(),
    packageId: z.uuid().nullable(),
    returnRequestId: z.uuid().nullable(),
    configVersionId: z.uuid().nullable(),
    txnId: z.string().nullable(),
    source: z.object({ type: z.string(), id: z.uuid() }).nullable(),
    reason: z.string().nullable(),
    createdAt: z.iso.datetime(),
    bankMatch: z.object({ bankRef: z.string(), by: z.object({ id: z.uuid(), name: z.string() }), at: z.iso.datetime() }).nullable(),
  })
  .meta({ id: 'LedgerLine' });

export const LedgerPage = z
  .object({
    items: z.array(LedgerLine),
    total: z.int(),
    page: z.int(),
    pageSize: z.int(),
    totals: z.object({ receivable: z.number(), platformBalance: z.number(), withdrawn: z.number(), committedPurchase: z.number().nullable() }),
  })
  .meta({ id: 'LedgerPage' });

export const OrderProfit = z
  .object({ net: z.number(), cogs: z.number().nullable(), gross: z.number().nullable(), estimated: z.boolean(), lines: z.array(LedgerLine) })
  .meta({ id: 'OrderProfit' });

export const TaxWarnings = z
  .object({
    regime: z.enum(['company', 'household', 'individual']).nullable(),
    items: z.array(z.object({ milestone: z.number(), ytdRevenue: z.number(), over: z.boolean() })),
  })
  .meta({ id: 'TaxWarnings' });
