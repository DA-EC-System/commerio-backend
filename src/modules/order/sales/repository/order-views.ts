// Đọc đơn cho danh sách, chi tiết (Documents/21 §19.1). Chạy trong `withCompany` của bên gọi.
import { and, count, desc, eq, gte, ilike, inArray, isNull, lt, notInArray, or, type SQL } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { customers, orderLines, orders, returnRequests } from './schema.ts';

const containsPattern = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export interface OrderFilter {
  search?: string | undefined;
  status?: (typeof orders.$inferSelect)['status'] | undefined;
  source?: (typeof orders.$inferSelect)['source'] | undefined;
  shopId?: string | undefined;
  paymentMethod?: 'prepaid' | 'cod' | undefined;
  customerId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
}

export type OrderViewRow = typeof orders.$inferSelect & { customer: { id: string; name: string; phone: string } | null };

function where(f: OrderFilter): SQL | undefined {
  const pattern = f.search ? containsPattern(f.search) : undefined;
  return and(
    pattern ? or(ilike(orders.code, pattern), ilike(orders.externalOrderId, pattern)) : undefined,
    f.status ? eq(orders.status, f.status) : undefined,
    f.source ? eq(orders.source, f.source) : undefined,
    f.shopId ? eq(orders.shopId, f.shopId) : undefined,
    f.paymentMethod ? eq(orders.paymentMethod, f.paymentMethod) : undefined,
    f.customerId ? eq(orders.customerId, f.customerId) : undefined,
    f.from ? gte(orders.createdAt, f.from) : undefined,
    f.to ? lt(orders.createdAt, f.to) : undefined,
  );
}

async function select(condition: SQL | undefined): Promise<OrderViewRow[]> {
  const rows = await getDb()
    .select({ order: orders, customer: { id: customers.id, name: customers.name, phone: customers.phone } })
    .from(orders)
    .leftJoin(customers, eq(customers.id, orders.customerId))
    .where(condition)
    .orderBy(desc(orders.createdAt), desc(orders.id));
  return rows.map((r) => ({
    ...r.order,
    customer: r.customer?.id ? { id: r.customer.id, name: r.customer.name ?? '', phone: r.customer.phone ?? '' } : null,
  }));
}

/** Mọi đơn khớp bộ lọc lưu trong DB, mới trước. Giai đoạn và cờ suy ra lọc tiếp ở service (7b). */
export const findOrders = (f: OrderFilter) => select(where(f));

export async function findOrder(id: string): Promise<OrderViewRow | undefined> {
  return (await select(eq(orders.id, id)))[0];
}

export type OrderLineRow = typeof orderLines.$inferSelect;

export async function findOrderLines(orderIds: readonly string[]): Promise<OrderLineRow[]> {
  if (!orderIds.length) return [];
  return getDb()
    .select()
    .from(orderLines)
    .where(inArray(orderLines.orderId, [...orderIds]))
    .orderBy(orderLines.createdAt, orderLines.id);
}

/** Số dòng và có dòng chưa ghép SKU, theo đơn. */
export async function lineFacts(orderIds: readonly string[]): Promise<Map<string, { lineCount: number; unmapped: boolean }>> {
  if (!orderIds.length) return new Map();
  const db = getDb();
  const [counts, unmapped] = await Promise.all([
    db
      .select({ orderId: orderLines.orderId, n: count() })
      .from(orderLines)
      .where(inArray(orderLines.orderId, [...orderIds]))
      .groupBy(orderLines.orderId),
    db
      .selectDistinct({ orderId: orderLines.orderId })
      .from(orderLines)
      .where(and(inArray(orderLines.orderId, [...orderIds]), isNull(orderLines.variantId))),
  ]);
  const unmappedIds = new Set(unmapped.map((r) => r.orderId));
  return new Map(counts.map((r) => [r.orderId, { lineCount: Number(r.n), unmapped: unmappedIds.has(r.orderId) }]));
}

/** Số yêu cầu trả còn mở theo đơn (chưa từ chối, chưa đóng). */
export async function openReturnCounts(orderIds: readonly string[]): Promise<Map<string, number>> {
  if (!orderIds.length) return new Map();
  const rows = await getDb()
    .select({ orderId: returnRequests.orderId, n: count() })
    .from(returnRequests)
    .where(and(inArray(returnRequests.orderId, [...orderIds]), notInArray(returnRequests.status, ['rejected', 'closed'])))
    .groupBy(returnRequests.orderId);
  return new Map(rows.map((r) => [r.orderId, Number(r.n)]));
}
