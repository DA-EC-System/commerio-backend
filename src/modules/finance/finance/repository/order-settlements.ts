import { and, count, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import type { SettlementState } from '../domain/settlement.ts';
import { orderSettlements } from './schema.ts';

export type OrderSettlementRow = typeof orderSettlements.$inferSelect;

export async function findOrderSettlement(orderId: string, lock?: 'update'): Promise<OrderSettlementRow | undefined> {
  const query = getDb().select().from(orderSettlements).where(eq(orderSettlements.orderId, orderId));
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/** Dòng trạng thái tiền của đơn, tạo ở `none` nếu chưa có; khoá tới hết giao dịch. */
export async function lockOrderSettlement(orderId: string, companyId: string, shopId: string | null): Promise<OrderSettlementRow> {
  await getDb().insert(orderSettlements).values({ orderId, companyId, shopId }).onConflictDoNothing();
  return (await findOrderSettlement(orderId, 'update'))!;
}

/** Sửa khi trạng thái và `version` còn như lúc đọc; tăng `version`. `undefined` khi đã có người sửa trước. */
export async function updateOrderSettlement(
  orderId: string,
  expect: { status: SettlementState; version: number },
  values: Partial<
    Pick<
      OrderSettlementRow,
      'status' | 'estimatedTotal' | 'settledTotal' | 'diff' | 'resolvedDiffBase' | 'resolvedBy' | 'resolvedAt' | 'resolvedReason' | 'approvedBy' | 'shopId'
    >
  >,
): Promise<OrderSettlementRow | undefined> {
  const [row] = await getDb()
    .update(orderSettlements)
    .set({ ...values, version: sql`${orderSettlements.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(orderSettlements.orderId, orderId), eq(orderSettlements.status, expect.status), eq(orderSettlements.version, expect.version)))
    .returning();
  return row;
}

export interface OrderSettlementFilter {
  status?: SettlementState;
  shopId?: string;
}

const where = (f: OrderSettlementFilter) =>
  and(f.status ? eq(orderSettlements.status, f.status) : undefined, f.shopId ? eq(orderSettlements.shopId, f.shopId) : undefined);

export async function listOrderSettlements(
  f: OrderSettlementFilter,
  page: { limit: number; offset: number },
): Promise<{ rows: OrderSettlementRow[]; total: number }> {
  const rows = await getDb()
    .select()
    .from(orderSettlements)
    .where(where(f))
    .orderBy(desc(orderSettlements.updatedAt), desc(orderSettlements.orderId))
    .limit(page.limit)
    .offset(page.offset);
  const [total] = await getDb().select({ n: count() }).from(orderSettlements).where(where(f));
  return { rows, total: total?.n ?? 0 };
}

/** Số đơn theo trạng thái tiền trong phạm vi gian hàng (đếm cho thẻ lọc). */
export async function countByStatus(shopId?: string): Promise<Record<SettlementState, number>> {
  const rows = await getDb()
    .select({ status: orderSettlements.status, n: count() })
    .from(orderSettlements)
    .where(shopId ? eq(orderSettlements.shopId, shopId) : undefined)
    .groupBy(orderSettlements.status);
  const out = { none: 0, pending: 0, settled: 0, mismatch: 0, resolved: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}
