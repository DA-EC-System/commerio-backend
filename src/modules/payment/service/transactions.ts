// Giao dịch cổng cho tab "Giao dịch cổng" (Documents/21 §12.3 hai dòng cuối, §12.8 `PaymentTransaction`; plan #27 AC-20).
// Đơn đọc qua `sales.getOrdersForFinance`; phiếu thu qua `ctx.financeRefsOf` (A21). Có `search` thì lọc trong bộ nhớ trên
// tập đã lọc theo DB (mã đơn nằm ở sales, A16), không thì phân trang ở DB.
import { requireCompanyId, withCompany } from '../../../shared/db/client.ts';
import { isUuid } from '../../../shared/uuid.ts';
import { AppError } from '../../../shared/errors/app-error.ts';
import { getOrdersForFinance } from '../../sales/index.ts';
import type { Gateway } from '../domain/gateways.ts';
import {
  countTransactions,
  findTransactions,
  findTransactionsByIds,
  type TransactionFilter,
} from '../repository/transactions.ts';
import type { PaymentContext } from './webhook-handler.ts';

type Row = Awaited<ReturnType<typeof findTransactions>>[number];

export interface TransactionQuery extends TransactionFilter {
  page: number;
  pageSize: number;
  search?: string;
}

const noRefs = { receipt: null, unmatchedReceiptId: null };

type Orders = Awaited<ReturnType<typeof getOrdersForFinance>>;
const ordersOf = (rows: Row[]) => getOrdersForFinance(rows.flatMap((r) => (r.transaction.orderId ? [r.transaction.orderId] : [])));

async function toViews(ctx: PaymentContext, rows: Row[], withPayload: boolean, known?: Orders) {
  const orders = known ?? (await ordersOf(rows));
  const refs = (await ctx.financeRefsOf?.(rows.map((r) => r.transaction.id))) ?? new Map();
  return rows.map(({ transaction: t, paymentCode }) => {
    const order = t.orderId ? orders.get(t.orderId) : undefined;
    return {
      id: t.id,
      gateway: t.gateway,
      gatewayTxnId: t.gatewayTxnId,
      paymentCode: paymentCode ?? null,
      order: order ? { id: order.id, code: order.code, customerName: order.customerName } : null,
      amount: Number(t.amount),
      source: t.source,
      status: t.status,
      occurredAt: t.occurredAt.toISOString(),
      ...(refs.get(t.id) ?? noRefs),
      ...(withPayload ? { rawPayload: t.rawPayload } : {}),
    };
  });
}

export function listTransactions(ctx: PaymentContext, companyId: string, q: TransactionQuery) {
  return withCompany(companyId, async () => {
    if (!q.search) {
      const page = { limit: q.pageSize, offset: (q.page - 1) * q.pageSize };
      const rows = await findTransactions(q, page);
      const total = await countTransactions(q);
      return { items: await toViews(ctx, rows, false), total, page: q.page, pageSize: q.pageSize };
    }
    const needle = q.search.toLowerCase();
    const all = await findTransactions(q);
    const orders = await ordersOf(all);
    const matched = all.filter((r) =>
      [r.paymentCode, r.transaction.gatewayTxnId, orders.get(r.transaction.orderId ?? '')?.code].some((v) =>
        v?.toLowerCase().includes(needle),
      ),
    );
    const start = (q.page - 1) * q.pageSize;
    const items = await toViews(ctx, matched.slice(start, start + q.pageSize), false, orders);
    return { items, total: matched.length, page: q.page, pageSize: q.pageSize };
  });
}

export function getTransaction(ctx: PaymentContext, companyId: string, id: string) {
  return withCompany(companyId, async () => {
    const rows = isUuid(id) ? await findTransactionsByIds([id]) : [];
    if (rows.length === 0) throw new AppError(404, 'not_found', 'Không tìm thấy giao dịch');
    return (await toViews(ctx, rows, true))[0]!;
  });
}

/** Cổng, mã thanh toán của các giao dịch (RLS) cho phiếu thu, khoản thu chưa khớp của finance (plan #27 A3). */
export async function getPaymentTransactions(
  ids: readonly string[],
): Promise<Map<string, { gateway: Gateway; paymentCode: string | null; orderId: string | null; occurredAt: Date }>> {
  requireCompanyId('getPaymentTransactions');
  const valid = ids.filter(isUuid);
  const rows = await findTransactionsByIds(valid);
  return new Map(
    rows.map(({ transaction: t, paymentCode }) => [
      t.id,
      { gateway: t.gateway, paymentCode: paymentCode ?? null, orderId: t.orderId, occurredAt: t.occurredAt },
    ]),
  );
}
