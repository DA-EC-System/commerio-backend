// Tồn và thẻ kho. Mọi hàm chạy trong `withCompany` của bên gọi (RLS + `company_id` của giao dịch).
// Ghi sổ theo phiếu kho, phiếu nhận, kiện làm ở các issue vòng đời (Documents/21 mục 15, 16, 19).
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb, requireCompanyId } from '../../../../shared/db/client.ts';
import { stockLevels, stockMoves } from './schema.ts';

export function companyOfTransaction(): string {
  return requireCompanyId('Thao tác kho');
}

export interface LevelRow {
  variantId: string;
  onHand: number;
  reserved: number;
  quarantine: number;
  avgCost: string;
  minQty: number | null;
  invariantBroken: boolean;
  version: number;
}

const levelCols = {
  variantId: stockLevels.variantId,
  onHand: stockLevels.onHand,
  reserved: stockLevels.reserved,
  quarantine: stockLevels.quarantine,
  avgCost: stockLevels.avgCost,
  minQty: stockLevels.minQty,
  invariantBroken: stockLevels.invariantBroken,
  version: stockLevels.version,
};

/**
 * Khoá dòng tồn của một biến thể, tạo dòng 0 nếu chưa có (chỉ với id đã kiểm qua `getVariants`, A17). `created`: dòng
 * do chính giao dịch này tạo; biết được sau khi khoá nên không lệch khi hai giao dịch cùng tạo.
 */
export async function lockLevel(variantId: string): Promise<LevelRow & { created: boolean }> {
  const companyId = companyOfTransaction();
  const inserted = await getDb()
    .insert(stockLevels)
    .values({ companyId, variantId })
    .onConflictDoNothing({ target: [stockLevels.companyId, stockLevels.variantId] })
    .returning({ variantId: stockLevels.variantId });
  const [row] = await getDb()
    .select(levelCols)
    .from(stockLevels)
    .where(and(eq(stockLevels.companyId, companyId), eq(stockLevels.variantId, variantId)))
    .for('update');
  return { ...row!, created: inserted.length > 0 };
}

export async function findLevel(variantId: string): Promise<LevelRow | null> {
  const [row] = await getDb()
    .select(levelCols)
    .from(stockLevels)
    .where(and(eq(stockLevels.companyId, companyOfTransaction()), eq(stockLevels.variantId, variantId)));
  return row ?? null;
}

export async function levelsOf(variantIds: readonly string[]): Promise<Map<string, LevelRow>> {
  if (!variantIds.length) return new Map();
  const rows = await getDb()
    .select(levelCols)
    .from(stockLevels)
    .where(and(eq(stockLevels.companyId, companyOfTransaction()), inArray(stockLevels.variantId, [...variantIds])));
  return new Map(rows.map((r) => [r.variantId, r]));
}

export async function allLevels(): Promise<Map<string, LevelRow>> {
  const rows = await getDb().select(levelCols).from(stockLevels).where(eq(stockLevels.companyId, companyOfTransaction()));
  return new Map(rows.map((r) => [r.variantId, r]));
}

/** Đặt hoặc bỏ ngưỡng (`null`), tăng `version` của dòng tồn. */
export async function setMinQty(variantId: string, minQty: number | null): Promise<void> {
  await getDb()
    .update(stockLevels)
    .set({ minQty, updatedAt: new Date(), version: sql`${stockLevels.version} + 1` })
    .where(and(eq(stockLevels.companyId, companyOfTransaction()), eq(stockLevels.variantId, variantId)));
}

/** Ghi số mới của dòng tồn đã khoá (`lockLevel`), tăng `version`. Chỉ lõi ghi sổ gọi. */
export async function saveLevel(
  variantId: string,
  next: { onHand: number; quarantine: number; avgCost: string; invariantBroken: boolean },
): Promise<void> {
  await getDb()
    .update(stockLevels)
    .set({ ...next, updatedAt: new Date(), version: sql`${stockLevels.version} + 1` })
    .where(and(eq(stockLevels.companyId, companyOfTransaction()), eq(stockLevels.variantId, variantId)));
}

export interface NewMove {
  variantId: string;
  bucket: 'on_hand' | 'quarantine';
  qtyChange: number;
  balanceAfter: number;
  unitCost: string | null;
  sourceType: MoveRow['sourceType'];
  sourceId: string;
  sourceLineId: string | null;
  doneBy: string | null;
}

export async function insertMoves(rows: readonly NewMove[]): Promise<void> {
  if (!rows.length) return;
  const companyId = companyOfTransaction();
  await getDb()
    .insert(stockMoves)
    .values(rows.map((r) => ({ ...r, companyId })));
}

export type MoveRow = {
  id: number;
  bucket: 'on_hand' | 'quarantine';
  qtyChange: number;
  balanceAfter: number;
  unitCost: string | null;
  sourceType: 'goods_receipt' | 'stock_document' | 'supplier_return';
  sourceId: string;
  doneAt: Date;
  doneBy: string | null;
};

/** `limit` dòng thẻ kho mới nhất của biến thể. */
export async function latestMoves(variantId: string, limit: number): Promise<MoveRow[]> {
  return getDb()
    .select({
      id: stockMoves.id,
      bucket: stockMoves.bucket,
      qtyChange: stockMoves.qtyChange,
      balanceAfter: stockMoves.balanceAfter,
      unitCost: stockMoves.unitCost,
      sourceType: stockMoves.sourceType,
      sourceId: stockMoves.sourceId,
      doneAt: stockMoves.doneAt,
      doneBy: stockMoves.doneBy,
    })
    .from(stockMoves)
    .where(and(eq(stockMoves.companyId, companyOfTransaction()), eq(stockMoves.variantId, variantId)))
    .orderBy(desc(stockMoves.id))
    .limit(limit);
}
