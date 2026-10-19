// Tiền COD (UC-PF-04; Documents/21 §12.5 dòng COD, T18, R2; plan #27 AC-25…AC-27). Danh sách đọc trạng thái tiền và ngày
// giao từ payment; xác nhận theo lô: tất cả hoặc không gì, mỗi đơn một phiếu thu `cod` = tổng đơn.
import { withCompany } from '../../../shared/db/client.ts';
import { AppError } from '../../../shared/errors/app-error.ts';
import { recordAudit } from '../../audit/index.ts';
import { listOrderPayments, markCodCollected, type PaymentStatus } from '../../payment/index.ts';
import { publishEvent } from '../../platform/index.ts';
import { getOrderForPayment } from '../../sales/index.ts';
import { findReceipts, insertReceipt } from '../repository/receipts.ts';
import { nextDocNumber } from './doc-numbers.ts';
import { money, notFound, ordersOf, orderRefWithPhone, type Page, paginate } from './views.ts';

export interface CodQuery extends Page {
  status: Extract<PaymentStatus, 'cod_pending' | 'cod_collected' | 'not_collected'>;
  from?: Date;
  to?: Date;
}

export function listCodOrders(companyId: string, q: CodQuery) {
  return withCompany(companyId, async () => {
    const rows = await listOrderPayments({
      status: q.status,
      // Chưa giao thì chưa có tiền để thu: tab chờ thu chỉ hiện đơn đã giao (plan #27 AC-25).
      delivered: q.status === 'cod_pending' || undefined,
      deliveredFrom: q.from,
      deliveredTo: q.to,
    });
    const orders = await ordersOf(rows.map((r) => r.orderId));
    const { slice, ...pageInfo } = paginate(rows, q, (r) => [orders.get(r.orderId)?.code, orders.get(r.orderId)?.customerName]);
    const receipts = await findReceipts({ source: 'cod', status: 'posted', orderIds: slice.map((r) => r.orderId) });
    const receiptOf = new Map(receipts.map((r) => [r.orderId, { id: r.id, number: r.number }]));
    return {
      items: slice.map((r) => ({
        order: orderRefWithPhone(orders, r.orderId),
        amount: r.amount.toNumber(),
        deliveredAt: r.deliveredAt?.toISOString() ?? null,
        status: r.status,
        receipt: receiptOf.get(r.orderId) ?? null,
      })),
      ...pageInfo,
    };
  });
}

/**
 * Thu COD cho cả lô trong giao dịch `withCompany` đang mở: khoá dòng đơn theo thứ tự id (A4) → `payment.markCodCollected`
 * (409 kèm danh sách nếu có đơn lệch, không đơn nào đổi) → mỗi đơn một phiếu thu `cod`, nhật ký, sự kiện.
 */
export async function collectCod(companyId: string, actorId: string | null, orderIds: readonly string[]) {
  const ids = [...new Set(orderIds)].toSorted();
  for (const id of ids) {
    if (!(await getOrderForPayment(id, { lock: 'share' }))) throw notFound('đơn hàng');
  }
  let states;
  try {
    states = await markCodCollected(ids);
  } catch (err) {
    if (!(err instanceof AppError && err.code === 'payment_state_changed')) throw err;
    const orders = await ordersOf(ids);
    const blocked = (err.extensions?.orders ?? []) as { orderId: string; status: string }[];
    throw new AppError(409, err.code, err.message, {
      orders: blocked.map((b) => ({ orderId: b.orderId, code: orders.get(b.orderId)?.code ?? null, status: b.status })),
    });
  }
  const receipts = [];
  for (const state of states) {
    const receipt = await insertReceipt({
      companyId,
      number: await nextDocNumber('receipt'),
      orderId: state.orderId,
      source: 'cod',
      amount: state.amount.toFixed(2),
    });
    await recordAudit({
      companyId,
      actorId,
      action: 'create',
      entityType: 'finance.receipts',
      entityId: receipt.id,
      after: { number: receipt.number, source: 'cod', orderId: state.orderId, amount: money(receipt.amount) },
    });
    await publishEvent({
      type: 'finance.receipt_posted',
      aggregateId: receipt.id,
      payload: {
        receiptId: receipt.id,
        orderId: state.orderId,
        amount: receipt.amount,
        source: 'cod',
        postedAt: receipt.postedAt.toISOString(),
        reversalOf: null,
      },
    });
    receipts.push({ orderId: state.orderId, receipt: { id: receipt.id, number: receipt.number } });
  }
  return receipts;
}

export function confirmCod(caller: { companyId: string; accountId: string }, orderIds: readonly string[]) {
  return withCompany(caller.companyId, async () => ({ receipts: await collectCod(caller.companyId, caller.accountId, orderIds) }));
}
