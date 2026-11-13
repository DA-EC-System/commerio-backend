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

const flag = (name: string) =>
  z
    .enum(['true', 'false'], `${name} là true hoặc false`)
    .transform((v) => v === 'true')
    .optional();

/** `GET /orders/profits` (#231): kỳ theo ngày giao (kiện đầu tiên giao xong, giờ Việt Nam), gồm cả hai ngày. */
export const OrderProfitsQuery = z
  .object({
    page: page.page,
    pageSize: page.pageSize,
    from: day('Từ ngày'),
    to: day('Đến ngày'),
    shopId: z.uuid('Gian hàng không hợp lệ').optional(),
    costMissing: flag('costMissing').meta({ description: '`true`: chỉ đơn thiếu giá vốn' }),
    belowFloor: flag('belowFloor').meta({ description: '`true`: chỉ đơn Dưới giá thấp nhất thực tế' }),
  })
  .refine((q) => q.from <= q.to, { path: ['to'], message: 'Đến ngày không được trước Từ ngày' });

export const OrderProfitItem = z
  .object({
    orderId: z.uuid(),
    code: z.string().nullable(),
    shopId: z.uuid().nullable(),
    deliveredAt: z.iso.datetime().nullable().meta({ description: 'Thời điểm kiện đầu tiên giao xong' }),
    net: z.number().meta({ description: 'Thực nhận của phần đã giao' }),
    cogs: z.number().nullable().meta({ description: 'Giá vốn (âm); `null` khi thiếu `inventory.cost.view`' }),
    gross: z.number().nullable().meta({ description: 'Lãi gộp = thực nhận + giá vốn; `null` khi thiếu `inventory.cost.view`' }),
    marginPct: z.number().nullable().meta({ description: 'Lãi gộp / thực nhận (%), một chữ số thập phân; `null` khi thực nhận ≤ 0 hoặc thiếu quyền xem giá vốn' }),
    estimated: z.boolean(),
    costMissing: z.boolean(),
    belowFloor: z.boolean().meta({ description: 'Dưới giá thấp nhất thực tế: đơn đã quyết toán có thực nhận < giá vốn × (1 + lãi tối thiểu)' }),
  })
  .meta({ id: 'OrderProfitSummary' });

export const OrderProfitPage = z
  .object({
    items: z.array(OrderProfitItem),
    totals: z
      .object({ net: z.number(), cogs: z.number().nullable(), gross: z.number().nullable() })
      .meta({ description: 'Tổng trên toàn bộ kết quả lọc, không chỉ trang' }),
    total: z.int(),
    page: z.int(),
    pageSize: z.int(),
  })
  .meta({ id: 'OrderProfitPage' });

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
    externalOrderId: z.string().nullable().meta({ description: 'Mã đơn sàn của khoản quyết toán' }),
    flags: z
      .array(z.enum(['unknown_order']))
      .meta({ description: '`unknown_order`: khoản của đơn sàn không có trong app (đơn trước khi kết nối, E140)' }),
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
  .object({ net: z.number(), cogs: z.number().nullable(), gross: z.number().nullable(), estimated: z.boolean(), costMissing: z.boolean(), lines: z.array(LedgerLine) })
  .meta({ id: 'OrderProfit' });

export const TaxWarnings = z
  .object({
    regime: z.enum(['company', 'household', 'individual']).nullable(),
    items: z.array(z.object({ milestone: z.number(), ytdRevenue: z.number(), over: z.boolean() })),
  })
  .meta({ id: 'TaxWarnings' });
