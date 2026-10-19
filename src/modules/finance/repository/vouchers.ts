import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { getDb } from '../../../shared/db/client.ts';
import { paymentVouchers, unmatchedReceipts } from './schema.ts';

export type VoucherRow = typeof paymentVouchers.$inferSelect;

export async function insertVoucher(values: typeof paymentVouchers.$inferInsert): Promise<VoucherRow> {
  const [row] = await getDb().insert(paymentVouchers).values(values).returning();
  return row!;
}

/** Phiếu chi; `lock` khoá dòng tới hết giao dịch (sửa, xoá, ghi sổ). */
export async function findVoucher(id: string, lock?: 'update'): Promise<VoucherRow | undefined> {
  const query = getDb().select().from(paymentVouchers).where(eq(paymentVouchers.id, id));
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/** Sửa phiếu đã khoá; tăng `version`, ghi `updated_at`. */
export async function updateVoucher(
  id: string,
  values: Partial<Pick<VoucherRow, 'amount' | 'paidOn' | 'note' | 'status' | 'postedBy' | 'postedAt'>>,
): Promise<VoucherRow> {
  const [row] = await getDb()
    .update(paymentVouchers)
    .set({ ...values, version: sql`${paymentVouchers.version} + 1`, updatedAt: sql`now()` })
    .where(eq(paymentVouchers.id, id))
    .returning();
  return row!;
}

export async function deleteVoucher(id: string): Promise<void> {
  await getDb().delete(paymentVouchers).where(eq(paymentVouchers.id, id));
}

/** Phiếu chi đã ghi sổ của chứng từ gốc (đơn hoặc khoản thu chưa khớp). */
export async function findPostedVoucherOf(source: { orderId?: string; unmatchedReceiptId?: string }) {
  const [row] = await getDb()
    .select({ id: paymentVouchers.id, number: paymentVouchers.number })
    .from(paymentVouchers)
    .where(
      and(
        eq(paymentVouchers.status, 'posted'),
        source.orderId ? eq(paymentVouchers.orderId, source.orderId) : undefined,
        source.unmatchedReceiptId ? eq(paymentVouchers.unmatchedReceiptId, source.unmatchedReceiptId) : undefined,
      ),
    );
  return row;
}

/** Phiếu chi hoàn tiền đã ghi sổ của các đơn (tab Cần hoàn tiền). */
export async function findRefundVouchersOfOrders(orderIds: readonly string[]) {
  if (orderIds.length === 0) return [];
  return getDb()
    .select({ orderId: paymentVouchers.orderId, id: paymentVouchers.id, number: paymentVouchers.number })
    .from(paymentVouchers)
    .where(
      and(
        eq(paymentVouchers.purpose, 'customer_refund'),
        eq(paymentVouchers.status, 'posted'),
        inArray(paymentVouchers.orderId, [...orderIds]),
      ),
    );
}

/** Phiếu chi hoàn khoản thu chưa khớp đã ghi sổ. */
export async function findRefundVouchersOfUnmatched(ids: readonly string[]) {
  if (ids.length === 0) return [];
  return getDb()
    .select({ unmatchedId: paymentVouchers.unmatchedReceiptId, id: paymentVouchers.id, number: paymentVouchers.number })
    .from(paymentVouchers)
    .where(
      and(
        eq(paymentVouchers.purpose, 'unmatched_refund'),
        eq(paymentVouchers.status, 'posted'),
        inArray(paymentVouchers.unmatchedReceiptId, [...ids]),
      ),
    );
}

export interface VoucherFilter {
  purpose?: VoucherRow['purpose'];
  status?: VoucherRow['status'];
  /** `yyyy-mm-dd`, theo `paid_on` (cột ngày). */
  from?: string;
  to?: string;
}

/** Phiếu chi của công ty (RLS), mới lập trước. */
export async function findVouchers(f: VoucherFilter): Promise<VoucherRow[]> {
  return getDb()
    .select()
    .from(paymentVouchers)
    .where(
      and(
        f.purpose ? eq(paymentVouchers.purpose, f.purpose) : undefined,
        f.status ? eq(paymentVouchers.status, f.status) : undefined,
        f.from ? gte(paymentVouchers.paidOn, f.from) : undefined,
        f.to ? lte(paymentVouchers.paidOn, f.to) : undefined,
      ),
    )
    .orderBy(desc(paymentVouchers.createdAt), desc(paymentVouchers.number));
}

/** Khoản thu chưa khớp đã xử lý xong: `open` → `refunded` / `assigned` (bên gọi đã khoá dòng). */
export async function setUnmatchedStatus(id: string, status: 'refunded' | 'assigned', assignedOrderId?: string): Promise<void> {
  await getDb()
    .update(unmatchedReceipts)
    .set({ status, assignedOrderId, version: sql`${unmatchedReceipts.version} + 1`, updatedAt: sql`now()` })
    .where(eq(unmatchedReceipts.id, id));
}
