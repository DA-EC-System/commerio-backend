// Lõi ghi sổ kho (spec #111 mục 5.4): nơi duy nhất đổi tồn thực và chờ xử lý. Chạy trong giao dịch của bên gọi.
// `applyMoves` không export ra `index.ts`: module khác gọi hàm theo nghiệp vụ (`receiveGoods`, sau này `ship`…).
import { publishEvent } from '../../../core/index.ts';
import { getVariants } from '../../catalog/index.ts';
import { availableQty, breaksInvariant, weightedAvgCost, worsens } from '../domain/stock.ts';
import { companyOfTransaction, insertMoves, lockLevel, type NewMove, saveLevel } from '../repository/levels.ts';
import type { stockSourceType } from '../repository/schema.ts';
import { lockedOf } from './port.ts';
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

/**
 * `allowBreak`: được làm vỡ bất biến tồn thực (bật cờ Tồn âm) — chỉ kiểm kê đã duyệt và bàn giao bắt buộc theo sàn
 * (Documents/25 §7.1). Chờ xử lý vẫn không được âm.
 */
export async function applyMoves(
  source: { type: StockSourceType; id: string },
  moves: readonly Move[],
  actorId: string | null,
  options: { allowBreak?: boolean } = {},
): Promise<void> {
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
    return after.quarantine < 0 || (!options.allowBreak && worsens(before, { onHand: after.onHand, reserved: before.reserved }));
  });
  if (short.length) throw new InsufficientStock(short);

  for (const id of ids) {
    const n = next.get(id)!;
    await saveLevel(id, { ...n, invariantBroken: breaksInvariant(n.onHand, levels.get(id)!.reserved) });
  }
  await insertMoves(rows);

  // Payload là số tuyệt đối sau khi ghi: bên nghe nhận trùng hay lệch thứ tự vẫn đúng (Q7).
  const touched = new Set(real.filter((m) => m.bucket === 'on_hand').map((m) => m.variantId));
  const locks = await lockedOf([...touched]);
  for (const variantId of [...touched].sort()) {
    const { onHand } = next.get(variantId)!;
    const { reserved } = levels.get(variantId)!;
    await publishEvent({
      type: 'inventory.stock_changed',
      aggregateId: variantId,
      payload: { variantId, onHand, reserved, available: availableQty(onHand, reserved, locks.get(variantId) ?? 0) },
    });
  }
  await recheckThresholds([...touched]);
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

export interface ReturnLine {
  /** Id dòng phiếu trả NCC, thành `source_line_id` của thẻ kho. */
  lineId: string;
  variantId: string;
  quantity: number;
  /** Giá vốn của dòng gốc (phiếu nhận, dòng kiện), chuỗi `numeric(18,2)`; `null` thì lấy giá vốn bình quân. */
  unitCost: string | null;
}

/**
 * Tồn theo phiếu trả NCC (#210, sơ đồ B4): `send` gửi đi thì chờ xử lý giảm; `back` NCC không nhận thì hàng về lại chờ
 * xử lý; `restock` huỷ phiếu chọn nhập lại thì chờ xử lý sang tồn thực theo giá vốn của dòng gốc. Chờ xử lý không đủ thì
 * `InsufficientStock` (bên gọi đổi sang 422 `stock_insufficient`).
 */
export async function moveSupplierReturn(
  returnId: string,
  kind: 'send' | 'back' | 'restock',
  lines: readonly ReturnLine[],
  actorId: string | null,
): Promise<void> {
  const moves = lines.flatMap((l): Move[] => {
    const base = { variantId: l.variantId, unitCost: l.unitCost, sourceLineId: l.lineId };
    if (kind === 'send') return [{ ...base, bucket: 'quarantine', qty: -l.quantity }];
    if (kind === 'back') return [{ ...base, bucket: 'quarantine', qty: l.quantity }];
    return [
      { ...base, bucket: 'quarantine', qty: -l.quantity },
      { ...base, bucket: 'on_hand', qty: l.quantity },
    ];
  });
  await applyMoves({ type: 'supplier_return', id: returnId }, moves, actorId);
}
