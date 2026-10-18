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

const levelCols = { variantId: stockLevels.variantId, onHand: stockLevels.onHand, reserved: stockLevels.reserved, avgCost: stockLevels.avgCost };
const ruleCols = {
  id: reorderRules.id,
  variantId: reorderRules.variantId,
  minQty: reorderRules.minQty,
  alertActive: reorderRules.alertActive,
  version: reorderRules.version,
};

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
    .select(levelCols)
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

/** Ghi giá vốn lúc ghi sổ lên dòng phiếu (dòng xuất, dòng nhập hoàn). */
export async function setLineCost(type: 'receipt' | 'issue', lineId: string, unitCost: string): Promise<void> {
  const t = type === 'receipt' ? stockReceiptLines : stockIssueLines;
  await getDb().update(t).set({ unitCost, updatedAt: new Date() }).where(eq(t.id, lineId));
}

export async function findRule(variantId: string): Promise<RuleRow | null> {
  const [row] = await getDb()
    .select(ruleCols)
    .from(reorderRules)
    .where(and(eq(reorderRules.companyId, companyOfTransaction()), eq(reorderRules.variantId, variantId)));
  return row ?? null;
}

/** Tồn một biến thể (không khoá); chưa có dòng thì `null`. */
export async function findLevel(variantId: string): Promise<LevelRow | null> {
  const [row] = await getDb()
    .select(levelCols)
    .from(stockLevels)
    .where(and(eq(stockLevels.companyId, companyOfTransaction()), eq(stockLevels.variantId, variantId)));
  return row ?? null;
}

export async function setRuleAlert(ruleId: string, alertActive: boolean): Promise<void> {
  await getDb().update(reorderRules).set({ alertActive }).where(eq(reorderRules.id, ruleId));
}

/** Giữ chỗ `active` của đơn, đọc không khoá (A6: khoá `stock_levels` trước rồi mới ghi `reservations`). */
export async function activeReservations(orderId: string) {
  return getDb()
    .select({ variantId: reservations.variantId, quantity: reservations.quantity })
    .from(reservations)
    .where(and(eq(reservations.orderId, orderId), eq(reservations.status, 'active')));
}

/**
 * Đặt số giữ chỗ `active` của (đơn, biến thể); dòng đã trả (`released`) thì bật lại. Dòng đã tiêu (`consumed`, đơn
 * đã xuất kho) không đổi: trả `false`.
 */
export async function upsertActiveReservation(orderId: string, variantId: string, quantity: number): Promise<boolean> {
  const rows = await getDb()
    .insert(reservations)
    .values({ companyId: companyOfTransaction(), orderId, variantId, quantity })
    .onConflictDoUpdate({
      target: [reservations.orderId, reservations.variantId],
      set: { quantity, status: 'active', updatedAt: new Date(), version: sql`${reservations.version} + 1` },
      setWhere: sql`${reservations.status} <> 'consumed'`,
    })
    .returning({ id: reservations.id });
  return rows.length > 0;
}

/** Chuyển mọi giữ chỗ `active` của đơn sang `to`, trả số thật đã chuyển (đọc dưới khoá). */
export async function closeActiveReservations(orderId: string, to: 'consumed' | 'released') {
  return getDb()
    .update(reservations)
    .set({ status: to, updatedAt: new Date(), version: sql`${reservations.version} + 1` })
    .where(and(eq(reservations.orderId, orderId), eq(reservations.status, 'active')))
    .returning({ variantId: reservations.variantId, quantity: reservations.quantity });
}

// ---------- Đọc tồn, ngưỡng, thẻ kho cho API (lát 4) ----------

/** Tồn của mọi biến thể trong công ty (không khoá); biến thể chưa có dòng thì vắng. */
export async function allLevels(): Promise<Map<string, LevelRow>> {
  const rows = await getDb().select(levelCols).from(stockLevels).where(eq(stockLevels.companyId, companyOfTransaction()));
  return new Map(rows.map((r) => [r.variantId, r]));
}

export interface RuleRow {
  id: string;
  variantId: string;
  minQty: number;
  alertActive: boolean;
  version: number;
}

export async function allRules(): Promise<Map<string, RuleRow>> {
  const rows = await getDb().select(ruleCols).from(reorderRules).where(eq(reorderRules.companyId, companyOfTransaction()));
  return new Map(rows.map((r) => [r.variantId, r]));
}

/** Đặt ngưỡng; chưa có dòng thì tạo (`version` 1), có rồi thì đổi và tăng `version`. */
export async function saveRule(variantId: string, minQty: number, existing: RuleRow | undefined): Promise<void> {
  if (existing) {
    await getDb()
      .update(reorderRules)
      .set({ minQty, updatedAt: new Date(), version: sql`${reorderRules.version} + 1` })
      .where(eq(reorderRules.id, existing.id));
  } else {
    await getDb().insert(reorderRules).values({ companyId: companyOfTransaction(), variantId, minQty });
  }
}

/** Bỏ ngưỡng: xoá dòng (V33, `reorderVersion` về 0). */
export async function deleteRule(ruleId: string): Promise<void> {
  await getDb().delete(reorderRules).where(eq(reorderRules.id, ruleId));
}

export type MoveRow = {
  id: string;
  qty_change: number;
  on_hand_after: number;
  unit_cost: string | null;
  done_at: Date;
  done_by: string | null;
  doc_id: string;
  doc_number: string;
  doc_type: 'receipt' | 'issue';
  doc_kind: 'purchase' | 'manual' | 'delivery_return' | 'order';
};

/** `limit` dòng thẻ kho mới nhất của biến thể kèm phiếu gốc (join trong schema inventory). */
export async function latestMoves(variantId: string, limit: number): Promise<MoveRow[]> {
  const result = await getDb().execute<MoveRow>(sql`
    select m.id::text as id, m.qty_change, m.on_hand_after, m.unit_cost, m.done_at, m.done_by,
      coalesce(r.id, i.id) as doc_id, coalesce(r.number, i.number) as doc_number,
      case when r.id is not null then 'receipt' else 'issue' end as doc_type,
      coalesce(r.kind::text, i.kind::text) as doc_kind
    from inventory.stock_moves m
    left join inventory.stock_receipt_lines rl on rl.id = m.receipt_line_id
    left join inventory.stock_receipts r on r.id = rl.receipt_id
    left join inventory.stock_issue_lines il on il.id = m.issue_line_id
    left join inventory.stock_issues i on i.id = il.issue_id
    where m.company_id = ${companyOfTransaction()} and m.variant_id = ${variantId}
    order by m.id desc
    limit ${limit}`);
  return result.rows;
}
