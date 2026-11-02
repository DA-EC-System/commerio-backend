import { and, eq, sql } from 'drizzle-orm';
import { getDb, requireCompanyId } from '../../../../shared/db/client.ts';
import type { OrderStatus } from '../domain/order.ts';
import { docCounters, orderLines, orders } from './schema.ts';

export interface MarketplaceOrderRow {
  id: string;
  code: string;
  status: OrderStatus;
  rawMarketplaceStatus: string | null;
  shipBy: Date | null;
  needsAttention: boolean;
  cancelRequested: boolean;
  cancelling: boolean;
  platformCancelled: boolean;
}

const rowColumns = {
  id: orders.id,
  code: orders.code,
  status: orders.status,
  rawMarketplaceStatus: orders.rawMarketplaceStatus,
  shipBy: orders.shipBy,
  needsAttention: orders.needsAttention,
  cancelRequested: orders.cancelRequested,
  cancelling: orders.cancelling,
  platformCancelled: orders.platformCancelled,
};

/** Đơn sàn theo mã đơn sàn, khoá dòng tới hết giao dịch. */
export async function lockMarketplaceOrder(shopId: string, externalOrderId: string): Promise<MarketplaceOrderRow | undefined> {
  const [row] = await getDb()
    .select(rowColumns)
    .from(orders)
    .where(and(eq(orders.shopId, shopId), eq(orders.externalOrderId, externalOrderId)))
    .for('update');
  return row;
}

/** Chèn đơn sàn; đơn đã có (lần kéo khác vừa chèn) thì trả `undefined`. */
export async function insertMarketplaceOrder(
  values: Omit<typeof orders.$inferInsert, 'companyId' | 'source'>,
): Promise<MarketplaceOrderRow | undefined> {
  const [row] = await getDb()
    .insert(orders)
    .values({ ...values, companyId: requireCompanyId('insertMarketplaceOrder'), source: 'marketplace' })
    .onConflictDoNothing()
    .returning(rowColumns);
  return row;
}

export async function updateOrder(id: string, patch: Partial<typeof orders.$inferInsert>): Promise<void> {
  await getDb()
    .update(orders)
    .set({ ...patch, version: sql`${orders.version} + 1`, updatedAt: sql`now()` })
    .where(eq(orders.id, id));
}

/** Chèn dòng đơn sàn chưa có (theo mã món sàn); trả id của mọi dòng theo mã món. */
export async function upsertMarketplaceLines(
  orderId: string,
  lines: readonly Omit<typeof orderLines.$inferInsert, 'companyId' | 'orderId'>[],
): Promise<Map<string, string>> {
  const db = getDb();
  if (lines.length) {
    const companyId = requireCompanyId('upsertMarketplaceLines');
    await db
      .insert(orderLines)
      .values(lines.map((l) => ({ ...l, companyId, orderId })))
      .onConflictDoNothing();
  }
  const rows = await db
    .select({ id: orderLines.id, externalLineId: orderLines.externalLineId })
    .from(orderLines)
    .where(eq(orderLines.orderId, orderId));
  return new Map(rows.map((r) => [r.externalLineId ?? '', r.id]));
}

/** Số tiếp theo của bộ đếm mã (`order`, `package`) trong công ty của giao dịch. */
export async function takeNextNumber(docType: string): Promise<number> {
  const [row] = await getDb()
    .insert(docCounters)
    .values({ companyId: requireCompanyId('takeNextNumber'), docType, nextNumber: 2 })
    .onConflictDoUpdate({
      target: [docCounters.companyId, docCounters.docType, docCounters.period],
      set: { nextNumber: sql`${docCounters.nextNumber} + 1` },
    })
    .returning({ n: sql<number>`${docCounters.nextNumber} - 1` });
  return Number(row!.n);
}

/** Sửa đơn khi còn đúng `version`, tăng `version`; không trúng dòng thì trả false để bên gọi báo 409. */
export async function updateOrderAt(id: string, version: number, patch: Partial<typeof orders.$inferInsert>): Promise<boolean> {
  const rows = await getDb()
    .update(orders)
    .set({ ...patch, version: sql`${orders.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(orders.id, id), eq(orders.version, version)))
    .returning({ id: orders.id });
  return rows.length > 0;
}

/**
 * Đơn `processing` có kiện và mọi kiện đã dừng, **mọi công ty**, cho việc nền tự hoàn tất: gọi ngoài `withCompany`
 * (role chủ bảng). Hạn trả hàng, yêu cầu trả mở kiểm tiếp trong `withCompany` của từng đơn.
 */
export async function findCompletionCandidates(): Promise<{ id: string; companyId: string }[]> {
  return getDb()
    .select({ id: orders.id, companyId: orders.companyId })
    .from(orders)
    .where(
      and(
        eq(orders.status, 'processing'),
        eq(orders.cancelling, false),
        sql`exists (select 1 from "order".packages p where p.order_id = ${orders.id})`,
        sql`not exists (select 1 from "order".packages p where p.order_id = ${orders.id}
              and p.status not in ('delivered', 'returned', 'lost', 'cancelled'))`,
      ),
    );
}
