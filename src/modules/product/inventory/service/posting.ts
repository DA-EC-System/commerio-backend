// Lõi ghi sổ kho (spec #111 mục 5.4, spec #206 mục 5.4): nơi duy nhất ghi `stock_levels` (tồn thực, đang giữ, chờ xử lý,
// giá vốn). Chạy trong giao dịch của bên gọi. `applyChange` không export ra `index.ts`: module khác gọi hàm theo nghiệp vụ
// (`receiveGoods`, cổng theo kiện).
import { publishEvent } from '../../../core/index.ts';
import { getVariants } from '../../catalog/index.ts';
import { availableQty, breaksInvariant, weightedAvgCost, worsens } from '../domain/stock.ts';
import { companyOfTransaction, insertMoves, type LevelRow, lockLevel, type NewMove, saveLevel } from '../repository/levels.ts';
import type { stockSourceType } from '../repository/schema.ts';
import { lockedOf } from './locked.ts';
import { recheckThresholds } from './thresholds.ts';

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

/** Một lần ghi `stock_levels`: biến động tồn thực, chờ xử lý (có thẻ kho) và phần cộng trừ đang giữ (không có thẻ kho). */
export interface StockChange {
  /** Chứng từ gốc của các move; chỉ được trống khi không có move (giữ, nhả hàng cho kiện). */
  source: { type: StockSourceType; id: string } | null;
  moves: readonly Move[];
  /** Phần cộng (dương) hoặc trừ (âm) vào đang giữ, theo `variantId`. */
  reserved?: ReadonlyMap<string, number>;
  /** Bàn giao bắt buộc theo sàn: bỏ bước kiểm "không làm tệ hơn", được vỡ bất biến (spec #206 Q10, Q14). */
  forced?: boolean;
  actorId: string | null;
}

/** Mọi id là biến thể của công ty đang chạy (`getVariants`, A17); id lạ là lỗi lập trình của bên gọi (500). */
export async function assertOwnVariants(variantIds: readonly string[]): Promise<void> {
  const owned = new Set((await getVariants(variantIds)).map((v) => v.id));
  const foreign = variantIds.filter((id) => !owned.has(id));
  if (foreign.length) throw new Error(`Biến thể không thuộc công ty: ${foreign.join(', ')}`);
}

/**
 * Khoá dòng tồn của các biến thể theo `variantId` tăng dần (Q8), tạo dòng 0 khi chưa có. Chỉ nhận biến thể thuộc công ty
 * (`getVariants`, A17); id lạ là lỗi lập trình của bên gọi. Gọi lại trong cùng giao dịch không tốn khoá thêm.
 */
export async function lockLevels(variantIds: readonly string[]): Promise<Map<string, LevelRow>> {
  const ids = [...new Set(variantIds)].sort();
  if (!ids.length) return new Map();
  await assertOwnVariants(ids);
  const levels = new Map<string, LevelRow>();
  for (const id of ids) levels.set(id, await lockLevel(id));
  return levels;
}

/**
 * Ghi một `StockChange`. `precheck` chạy sau khi khoá, trên số trước khi ghi; trả false thì không ghi gì và `applyChange`
 * trả false (giữ nguyên kiện). Thứ tự kiểm: đang giữ âm (lỗi lập trình) → chờ xử lý âm → "không làm tệ hơn"
 * (`InsufficientStock`, bỏ qua khi `forced`). Phát `stock_changed` cho SKU có tồn thực đổi; xét lại ngưỡng cho SKU có
 * tồn thực hoặc đang giữ đổi (spec #206 Q15). SKU chỉ đổi đang giữ thì không tăng `version` (Q24).
 */
export async function applyChange(change: StockChange, precheck?: (locked: ReadonlyMap<string, LevelRow>) => boolean): Promise<boolean> {
  companyOfTransaction();
  const moves = change.moves.filter((m) => m.qty !== 0);
  const reserved = new Map([...(change.reserved ?? [])].filter(([, q]) => q !== 0));
  if (!moves.length && !reserved.size) return true;
  const source = change.source;
  if (moves.length && !source) throw new Error('Có biến động tồn mà không có chứng từ gốc');

  const levels = await lockLevels([...moves.map((m) => m.variantId), ...reserved.keys()]);
  if (precheck && !precheck(levels)) return false;

  const next = new Map(
    [...levels].map(([id, l]) => [
      id,
      { onHand: l.onHand, reserved: l.reserved + (reserved.get(id) ?? 0), quarantine: l.quarantine, avgCost: l.avgCost },
    ]),
  );
  const rows: NewMove[] = moves.map((m) => {
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
      sourceType: source!.type,
      sourceId: source!.id,
      sourceLineId: m.sourceLineId,
      doneBy: change.actorId,
    };
  });

  const ids = [...levels.keys()];
  const overReleased = ids.filter((id) => next.get(id)!.reserved < 0);
  if (overReleased.length) throw new Error(`Lõi ghi sổ nhả quá số đang giữ: ${overReleased.join(', ')}`);
  const short = ids.filter((id) => {
    const after = next.get(id)!;
    return after.quarantine < 0 || (!change.forced && worsens(levels.get(id)!, after));
  });
  if (short.length) throw new InsufficientStock(short);

  const moved = new Set(moves.map((m) => m.variantId));
  for (const id of ids) {
    const n = next.get(id)!;
    await saveLevel(id, { ...n, invariantBroken: breaksInvariant(n.onHand, n.reserved) }, moved.has(id));
  }
  await insertMoves(rows);

  // Payload là số tuyệt đối sau khi ghi: bên nghe nhận trùng hay lệch thứ tự vẫn đúng (Q7).
  const onHandChanged = new Set(moves.filter((m) => m.bucket === 'on_hand').map((m) => m.variantId));
  for (const variantId of [...onHandChanged].sort()) {
    const { onHand, reserved: held } = next.get(variantId)!;
    await publishEvent({
      type: 'inventory.stock_changed',
      aggregateId: variantId,
      payload: { variantId, onHand, reserved: held, available: availableQty(onHand, held, lockedOf(variantId)) },
    });
  }
  await recheckThresholds([...new Set([...onHandChanged, ...reserved.keys()])]);
  return true;
}

/** Biến động tồn thực, chờ xử lý theo một chứng từ gốc (không đổi đang giữ). */
export async function applyMoves(source: { type: StockSourceType; id: string }, moves: readonly Move[], actorId: string | null): Promise<void> {
  await applyChange({ source, moves, actorId });
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
