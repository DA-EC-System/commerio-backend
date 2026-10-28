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

/** Khoá dòng tồn của một biến thể, tạo dòng 0 nếu chưa có (chỉ với id đã kiểm qua `getVariants`, A17). */
export async function lockLevel(variantId: string): Promise<LevelRow> {
  const companyId = companyOfTransaction();
  await getDb()
    .insert(stockLevels)
    .values({ companyId, variantId })
    .onConflictDoNothing({ target: [stockLevels.companyId, stockLevels.variantId] });
  const [row] = await getDb()
    .select(levelCols)
    .from(stockLevels)
    .where(and(eq(stockLevels.companyId, companyId), eq(stockLevels.variantId, variantId)))
    .for('update');
  return row!;
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
