// Tồn, thẻ kho, giữ chỗ, ngưỡng. Mọi hàm chạy trong `withCompany` của bên gọi (RLS + `company_id` của giao dịch).
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { currentCompanyId, getDb } from '../../../shared/db/client.ts';
import { reorderRules, reservations, stockIssueLines, stockLevels, stockMoves, stockReceiptLines } from './schema.ts';

export function companyOfTransaction(): string {
  const companyId = currentCompanyId();
  if (!companyId) throw new Error('Thao tác kho phải chạy trong withCompany');
  return companyId;
}

export interface LevelRow {
  variantId: string;
  onHand: number;
  reserved: number;
  avgCost: string;
}

/**
 * Khoá dòng tồn theo `variant_id` tăng dần (plan #16 A6: thứ tự khoá chung, chống deadlock). `create` = tạo dòng 0
 * cho biến thể chưa có (chỉ đường nhập hàng, với id đã kiểm, A17); không tạo thì biến thể chưa có vắng trong kết quả.
 */
export async function lockLevels(variantIds: readonly string[], create: boolean): Promise<Map<string, LevelRow>> {
  const ids = [...new Set(variantIds)].sort();
  if (ids.length === 0) return new Map();
  const companyId = companyOfTransaction();
  if (create) {
    await getDb()
      .insert(stockLevels)
      .values(ids.map((variantId) => ({ companyId, variantId })))
      .onConflictDoNothing({ target: [stockLevels.companyId, stockLevels.variantId] });
  }
  const rows = await getDb()
    .select({ variantId: stockLevels.variantId, onHand: stockLevels.onHand, reserved: stockLevels.reserved, avgCost: stockLevels.avgCost })
    .from(stockLevels)
    .where(and(eq(stockLevels.companyId, companyId), inArray(stockLevels.variantId, ids)))
    .orderBy(asc(stockLevels.variantId))
    .for('update');
  return new Map(rows.map((r) => [r.variantId, r]));
}

export async function updateLevel(level: LevelRow): Promise<void> {
  await getDb()
    .update(stockLevels)
    .set({
      onHand: level.onHand,
      reserved: level.reserved,
      avgCost: level.avgCost,
      updatedAt: new Date(),
      version: sql`${stockLevels.version} + 1`,
    })
    .where(and(eq(stockLevels.companyId, companyOfTransaction()), eq(stockLevels.variantId, level.variantId)));
}

export async function insertMove(move: {
  variantId: string;
  qtyChange: number;
  onHandAfter: number;
  receiptLineId?: string;
  issueLineId?: string;
  unitCost: string;
  doneBy: string | null;
}): Promise<void> {
  await getDb()
    .insert(stockMoves)
    .values({ companyId: companyOfTransaction(), ...move });
}

export async function setReceiptLineCost(lineId: string, unitCost: string): Promise<void> {
  await getDb().update(stockReceiptLines).set({ unitCost, updatedAt: new Date() }).where(eq(stockReceiptLines.id, lineId));
}

export async function setIssueLineCost(lineId: string, unitCost: string): Promise<void> {
  await getDb().update(stockIssueLines).set({ unitCost, updatedAt: new Date() }).where(eq(stockIssueLines.id, lineId));
}

export async function findRule(variantId: string) {
  const [row] = await getDb()
    .select({ id: reorderRules.id, minQty: reorderRules.minQty, alertActive: reorderRules.alertActive })
    .from(reorderRules)
    .where(and(eq(reorderRules.companyId, companyOfTransaction()), eq(reorderRules.variantId, variantId)));
  return row ?? null;
}

export async function setRuleAlert(ruleId: string, alertActive: boolean): Promise<void> {
  await getDb().update(reorderRules).set({ alertActive }).where(eq(reorderRules.id, ruleId));
}

/** Giữ chỗ của đơn, đọc không khoá (A6: khoá `stock_levels` trước rồi mới ghi `reservations`). */
export async function reservationsOfOrder(orderId: string) {
  return getDb()
    .select({ id: reservations.id, variantId: reservations.variantId, quantity: reservations.quantity, status: reservations.status })
    .from(reservations)
    .where(eq(reservations.orderId, orderId));
}

/** Đặt số giữ chỗ `active` của (đơn, biến thể); dòng cũ không `active` thì bật lại với số mới. */
export async function upsertActiveReservation(orderId: string, variantId: string, quantity: number): Promise<void> {
  await getDb()
    .insert(reservations)
    .values({ companyId: companyOfTransaction(), orderId, variantId, quantity })
    .onConflictDoUpdate({
      target: [reservations.orderId, reservations.variantId],
      set: { quantity, status: 'active', updatedAt: new Date(), version: sql`${reservations.version} + 1` },
    });
}

/** Chuyển mọi giữ chỗ `active` của đơn sang `to`, trả số thật đã chuyển (đọc dưới khoá). */
export async function closeActiveReservations(orderId: string, to: 'consumed' | 'released') {
  return getDb()
    .update(reservations)
    .set({ status: to, updatedAt: new Date(), version: sql`${reservations.version} + 1` })
    .where(and(eq(reservations.orderId, orderId), eq(reservations.status, 'active')))
    .returning({ variantId: reservations.variantId, quantity: reservations.quantity });
}
