import { randomUUID } from 'node:crypto';
import { createVariant } from '../helpers/catalog.ts';
import { registerCompany } from '../helpers/company.ts';
import { testPool } from '../helpers/db.ts';
import type { EventType } from '#src/modules/platform/index.ts';
import { stockIssueLines, stockIssues, stockReceiptLines, stockReceipts } from '#src/modules/inventory/repository/schema.ts';
import { applyStockMoves } from '#src/modules/inventory/service/posting.ts';
import { getDb, withCompany } from '#src/shared/db/client.ts';

/** Công ty mới qua API đăng ký (không cần token) và `n` biến thể của nó. */
export async function companyWithVariants(n = 1) {
  const { companyId } = await registerCompany();
  const variants: string[] = [];
  for (let i = 0; i < n; i++) variants.push((await createVariant(companyId)).variantId);
  return { companyId, variants };
}

export interface Level {
  onHand: number;
  reserved: number;
  avgCost: string;
}

/** Dòng tồn đọc bằng role chủ bảng; chưa có dòng thì `null`. */
export async function levelOf(companyId: string, variantId: string): Promise<Level | null> {
  const { rows } = await testPool().query<{ on_hand: number; reserved: number; avg_cost: string }>(
    'select on_hand, reserved, avg_cost from inventory.stock_levels where company_id = $1 and variant_id = $2',
    [companyId, variantId],
  );
  const r = rows[0];
  return r ? { onHand: r.on_hand, reserved: r.reserved, avgCost: r.avg_cost } : null;
}

/** Payload các sự kiện của công ty trong outbox, cũ trước. */
export async function eventsOf(companyId: string, type: EventType): Promise<Record<string, unknown>[]> {
  const { rows } = await testPool().query<{ payload: Record<string, unknown> }>(
    'select payload from platform.outbox_messages where company_id = $1 and type = $2 order by id',
    [companyId, type],
  );
  return rows.map((r) => r.payload);
}

export async function movesOf(companyId: string, variantId: string) {
  const { rows } = await testPool().query<{ qty_change: number; on_hand_after: number; unit_cost: string | null; done_by: string | null }>(
    'select qty_change, on_hand_after, unit_cost, done_by from inventory.stock_moves where company_id = $1 and variant_id = $2 order by id',
    [companyId, variantId],
  );
  return rows;
}

const number = (prefix: string) => `${prefix}-T${randomUUID().slice(0, 8)}`;

/**
 * Ghi sổ một phiếu nhập tay một dòng như luồng ghi sổ thật (phiếu `done` + khung `applyStockMoves`), dùng để có tồn
 * khi API phiếu (lát 3) chưa có. Trạng thái tạo ra giống hệt `POST /inventory/documents/:id/post`.
 */
export async function receive(companyId: string, variantId: string, quantity: number, unitCost: number | string) {
  await withCompany(companyId, async () => {
    const [doc] = await getDb()
      .insert(stockReceipts)
      .values({ companyId, number: number('PN'), kind: 'manual', status: 'done', postedAt: new Date() })
      .returning({ id: stockReceipts.id });
    const [line] = await getDb()
      .insert(stockReceiptLines)
      .values({ companyId, receiptId: doc!.id, variantId, quantity, unitCost: String(unitCost) })
      .returning({ id: stockReceiptLines.id });
    await applyStockMoves({
      direction: 'in',
      cost: 'weighted',
      doneBy: null,
      lines: [{ variantId, quantity, lineId: line!.id, unitCost }],
    });
  });
}

/** Phiếu xuất tay đã ghi sổ (như lát 3 sẽ làm), nhiều dòng; lỗi của khung (vd `insufficient_stock`) ném ra nguyên vẹn. */
export async function issueManual(companyId: string, lines: { variantId: string; quantity: number }[]) {
  return withCompany(companyId, async () => {
    const [doc] = await getDb()
      .insert(stockIssues)
      .values({ companyId, number: number('PX'), kind: 'manual', status: 'done', note: 'hàng hỏng', postedAt: new Date() })
      .returning({ id: stockIssues.id });
    const moveLines = [];
    for (const l of lines) {
      const [row] = await getDb()
        .insert(stockIssueLines)
        .values({ companyId, issueId: doc!.id, variantId: l.variantId, quantity: l.quantity })
        .returning({ id: stockIssueLines.id });
      moveLines.push({ ...l, lineId: row!.id });
    }
    await applyStockMoves({ direction: 'out', cost: 'current', doneBy: null, lines: moveLines });
    return doc!.id;
  });
}

/** Ngưỡng tồn đặt thẳng vào bảng (API ngưỡng là lát 4); `alert_active` như lúc chưa từng cảnh báo. */
export async function setRule(companyId: string, variantId: string, minQty: number) {
  await testPool().query('insert into inventory.reorder_rules (company_id, variant_id, min_qty) values ($1, $2, $3)', [
    companyId,
    variantId,
    minQty,
  ]);
}

export async function alertActive(companyId: string, variantId: string): Promise<boolean | null> {
  const { rows } = await testPool().query<{ alert_active: boolean }>(
    'select alert_active from inventory.reorder_rules where company_id = $1 and variant_id = $2',
    [companyId, variantId],
  );
  return rows[0]?.alert_active ?? null;
}
