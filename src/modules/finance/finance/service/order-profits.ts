// `GET /finance/orders/profits` (#231; Documents/21 §21.1, 25 §10.2): lãi theo danh sách đơn của phần đã giao.
import { Decimal } from 'decimal.js';
import { withCompany } from '../../../../shared/db/client.ts';
import { findPackagesOfOrders } from '../../../order/index.ts';
import { appliedTimeline, type ConfigPayload } from '../domain/config-version.ts';
import { marginPct } from '../domain/order-profit.ts';
import { findCell } from '../repository/config-versions.ts';
import { findOrderProfits, type MarginSegment, orderProfitTotals } from '../repository/order-profits.ts';
import { ordersOf } from './views.ts';

export interface OrderProfitsQuery {
  from: string;
  to: string;
  shopId?: string;
  costMissing?: boolean;
  belowFloor?: boolean;
  page: number;
  pageSize: number;
}

/** Mốc lãi tối thiểu (`min_margin`, cấp công ty) đã áp dụng, để chọn bản theo ngày giao của từng đơn trong SQL. */
async function marginSegments(): Promise<MarginSegment[]> {
  const versions = appliedTimeline(await findCell('min_margin', null, ['active', 'expired']));
  return versions.map((v) => ({ from: v.effectiveFrom, to: v.effectiveTo, pct: (v.payload as ConfigPayload<'min_margin'>).pct }));
}

/** Thời điểm kiện đầu tiên của đơn giao xong (`packages.delivered_at`, qua cổng của order). */
async function deliveredAtOf(orderIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, Date>();
  for (const p of await findPackagesOfOrders(orderIds)) {
    if (!p.deliveredAt) continue;
    const seen = out.get(p.orderId);
    if (!seen || p.deliveredAt < seen) out.set(p.orderId, p.deliveredAt);
  }
  return new Map([...out].map(([id, at]) => [id, at.toISOString()]));
}

const money = (v: Decimal.Value) => new Decimal(v).toNumber();

/**
 * Lãi theo đơn trong kỳ giao: chỉ phần đã giao, `estimated` tới khi quyết toán; tổng tính trên toàn bộ kết quả lọc.
 * Không có quyền xem giá vốn thì `cogs`, `gross`, `marginPct` là `null` (R4).
 */
export function listOrderProfits(companyId: string, q: OrderProfitsQuery, canSeeCost: boolean) {
  return withCompany(companyId, async () => {
    const filter = { from: q.from, to: q.to, shopId: q.shopId, costMissing: q.costMissing, belowFloor: q.belowFloor, margins: await marginSegments() };
    const rows = await findOrderProfits(filter, { limit: q.pageSize, offset: (q.page - 1) * q.pageSize });
    const sums = await orderProfitTotals(filter);
    const ids = rows.map((r) => r.orderId);
    const orders = await ordersOf(ids);
    const deliveredAt = await deliveredAtOf(ids);
    return {
      items: rows.map((r) => {
        const gross = new Decimal(r.net).plus(r.cogs);
        return {
          orderId: r.orderId,
          code: orders.get(r.orderId)?.code ?? null,
          shopId: r.shopId,
          deliveredAt: deliveredAt.get(r.orderId) ?? null,
          net: money(r.net),
          cogs: canSeeCost ? money(r.cogs) : null,
          gross: canSeeCost ? gross.toNumber() : null,
          marginPct: canSeeCost ? marginPct(r.net, gross) : null,
          estimated: r.estimated,
          costMissing: r.costMissing,
          belowFloor: r.belowFloor,
        };
      }),
      totals: {
        net: money(sums.net),
        cogs: canSeeCost ? money(sums.cogs) : null,
        gross: canSeeCost ? new Decimal(sums.net).plus(sums.cogs).toNumber() : null,
      },
      total: sums.total,
      page: q.page,
      pageSize: q.pageSize,
    };
  });
}
