// Lõi ghi sổ kho (spec #111 mục 5.4): nơi duy nhất đổi tồn thực và chờ xử lý. Chạy trong giao dịch của bên gọi.
// `applyMoves` không export ra `index.ts`: module khác gọi hàm theo nghiệp vụ (`receiveGoods`, sau này `ship`…).
import { publishEvent } from '../../../core/index.ts';
import { getVariants } from '../../catalog/index.ts';
import { availableQty, breaksInvariant, weightedAvgCost, worsens } from '../domain/stock.ts';
import { companyOfTransaction, insertMoves, lockLevel, type NewMove, saveLevel } from '../repository/levels.ts';
import type { stockSourceType } from '../repository/schema.ts';
import { lockedOf } from './port.ts';

export type StockSourceType = (typeof stockSourceType.enumValues)[number];

export interface Move {
  variantId: string;
  bucket: 'on_hand' | 'quarantine';
  /** Khác 0, nguyên; âm là giảm. */
  qty: number;
  /** Giá của lần nhập; move `on_hand` dương có giá thì tính lại giá vốn bình quân. */
  unitCost: string | null;
  sourceLineId: string | null;
}

/** Giảm làm vỡ bất biến hoặc chờ xử lý âm. Lỗi nội bộ: hàm cổng giảm tồn đổi sang 422 `stock_insufficient`. */
export class InsufficientStock extends Error {
  readonly variantIds: string[];

  constructor(variantIds: string[]) {
    super(`Không đủ tồn: ${variantIds.join(', ')}`);
    this.name = 'InsufficientStock';
    this.variantIds = variantIds;
  }
}

export async function applyMoves(source: { type: StockSourceType; id: string }, moves: readonly Move[], actorId: string | null): Promise<void> {
  companyOfTransaction();
  const real = moves.filter((m) => m.qty !== 0);
  if (!real.length) return;

  // Khoá theo variantId tăng dần: hai giao dịch cùng đụng nhiều SKU không khoá chéo nhau (Q8).
  const ids = [...new Set(real.map((m) => m.variantId))].sort();
  const owned = new Set((await getVariants(ids)).map((v) => v.id));
  const foreign = ids.filter((id) => !owned.has(id));
  if (foreign.length) throw new Error(`Biến thể không thuộc công ty: ${foreign.join(', ')}`);

  const levels = new Map<string, Awaited<ReturnType<typeof lockLevel>>>();
  for (const id of ids) levels.set(id, await lockLevel(id));
  const next = new Map([...levels].map(([id, l]) => [id, { onHand: l.onHand, quarantine: l.quarantine, avgCost: l.avgCost }]));

  const rows: NewMove[] = real.map((m) => {
    const n = next.get(m.variantId)!;
    if (m.bucket === 'on_hand') {
      if (m.qty > 0 && m.unitCost !== null) n.avgCost = weightedAvgCost(n.onHand, n.avgCost, m.qty, m.unitCost).toFixed(2);
      n.onHand += m.qty;
    } else {
      n.quarantine += m.qty;
    }
    return {
      variantId: m.variantId,
      bucket: m.bucket,
      qtyChange: m.qty,
      balanceAfter: m.bucket === 'on_hand' ? n.onHand : n.quarantine,
      unitCost: m.unitCost,
      sourceType: source.type,
      sourceId: source.id,
      sourceLineId: m.sourceLineId,
      doneBy: actorId,
    };
  });

  const short = ids.filter((id) => {
    const before = levels.get(id)!;
    const after = next.get(id)!;
    return after.quarantine < 0 || worsens(before, { onHand: after.onHand, reserved: before.reserved });
  });
  if (short.length) throw new InsufficientStock(short);

  for (const id of ids) {
    const n = next.get(id)!;
    await saveLevel(id, { ...n, invariantBroken: breaksInvariant(n.onHand, levels.get(id)!.reserved) });
  }
  await insertMoves(rows);

  // Payload là số tuyệt đối sau khi ghi: bên nghe nhận trùng hay lệch thứ tự vẫn đúng (Q7).
  const touched = new Set(real.filter((m) => m.bucket === 'on_hand').map((m) => m.variantId));
  for (const variantId of [...touched].sort()) {
    const { onHand } = next.get(variantId)!;
    const { reserved } = levels.get(variantId)!;
    await publishEvent({
      type: 'inventory.stock_changed',
      aggregateId: variantId,
      payload: { variantId, onHand, reserved, available: availableQty(onHand, reserved, lockedOf(variantId)) },
    });
  }
}

export interface ReceivedLine {
  /** Id dòng phiếu nhận, thành `source_line_id` của thẻ kho. */
  lineId: string;
  variantId: string;
  accepted: number;
  defective: number;
  /** Giá nhập của dòng đề nghị, chuỗi `numeric(18,2)`. */
  unitCost: string;
}

/**
 * Ghi sổ phiếu nhận (#109): số đạt vào tồn thực theo giá nhập, số lỗi vào chờ xử lý. Giá của hàng lỗi lưu trên thẻ kho
 * nhưng không vào giá vốn bình quân.
 */
export async function receiveGoods(receiptId: string, lines: readonly ReceivedLine[], actorId: string | null): Promise<void> {
  const moves = lines.flatMap((l): Move[] => [
    { variantId: l.variantId, bucket: 'on_hand', qty: l.accepted, unitCost: l.unitCost, sourceLineId: l.lineId },
    { variantId: l.variantId, bucket: 'quarantine', qty: l.defective, unitCost: l.unitCost, sourceLineId: l.lineId },
  ]);
  await applyMoves({ type: 'goods_receipt', id: receiptId }, moves, actorId);
}
