// Bàn giao và đảo bàn giao theo kiện (Documents/21 mục 11.1, spec #206 mục 5.5). Chạy trong giao dịch của bên gọi;
// fulfillment khoá kiện trước khi gọi và chặn gọi lặp bằng `stock_deducted` (Q12). Thứ tự khoá: dòng tồn theo
// `variantId` → `doc_counters`.
import { activeRound, type DocumentRef, mergeLines, sameLines, type StockLine } from '../domain/documents.ts';
import { averageCost } from '../domain/stock.ts';
import { packageShipments } from '../repository/documents.ts';
import { createSystemDocument } from './documents.ts';
import { applyChange, lockLevels, type Move } from './posting.ts';

export interface ShipOptions {
  /** Người quét bàn giao; trống khi sàn báo bàn giao. */
  actorId: string | null;
  /** Bàn giao bắt buộc theo sàn (Documents/25 §8.4 quy tắc 3): trừ đủ tồn thực, không trừ đang giữ, được vỡ bất biến. */
  forced?: boolean;
}

const FORCED_NOTE = 'Bàn giao bắt buộc theo sàn';
const REASON_MAX = 500;

/**
 * Lập phiếu xuất `XK` đã ghi sổ theo giá vốn bình quân lúc khoá, trừ tồn thực; bàn giao thường trừ cả đang giữ. Trong
 * lượt đang xuất (Q17) đã có phiếu cùng dòng thì trả phiếu đó, không trừ tồn lần nữa.
 */
export async function ship(packageId: string, lines: readonly StockLine[], opts: ShipOptions): Promise<DocumentRef> {
  const wanted = mergeLines(lines);
  if (!wanted.size) throw new Error(`Kiện ${packageId} bàn giao không có dòng hàng`);
  const levels = await lockLevels([...wanted.keys()]);

  // Lưới gọi lặp (Q12): đọc sau khi khoá dòng tồn, nên lần gọi trùng chạy song song thấy phiếu đã commit.
  const repeat = activeRound(await packageShipments(packageId)).find((d) => sameLines(mergeLines(d.lines), wanted));
  if (repeat) return { documentId: repeat.id, number: repeat.number };

  const forced = opts.forced === true;
  if (!forced) {
    // Kiểm trước khi lấy số phiếu (Q21): bên gọi bắt lỗi mà vẫn commit thì bộ đếm không nhảy số, và đường lỗi không
    // giữ khoá dòng đếm `doc_counters` (khoá chung của mọi `ship` trong công ty).
    const unheld = [...wanted].filter(([id, q]) => levels.get(id)!.reserved < q).map(([id]) => id);
    if (unheld.length) throw new Error(`Kiện ${packageId} chưa giữ hàng (${unheld.join(', ')}); bàn giao bắt buộc thì truyền forced`);
  }

  const costOf = (variantId: string) => levels.get(variantId)!.avgCost;
  const { ref, lineIdOf } = await createSystemDocument({
    kind: 'shipment',
    status: 'posted',
    sourceType: 'package',
    sourceId: packageId,
    actorId: opts.actorId,
    note: forced ? FORCED_NOTE : null,
    lines: [...wanted].map(([variantId, quantity]) => ({ variantId, quantity, expectedQty: null, unitCost: costOf(variantId) })),
  });
  await applyChange({
    source: { type: 'stock_document', id: ref.documentId },
    moves: [...wanted].map(
      ([variantId, q]): Move => ({ variantId, bucket: 'on_hand', qty: -q, unitCost: costOf(variantId), sourceLineId: lineIdOf.get(variantId)! }),
    ),
    ...(forced ? {} : { reserved: new Map([...wanted].map(([id, q]) => [id, -q])) }),
    forced,
    actorId: opts.actorId,
  });
  return ref;
}

/**
 * Đảo lượt bàn giao gần nhất chưa đảo (Q17, Documents/25 §8.3): lập phiếu `DX` đã ghi sổ, cộng lại tồn thực và đang giữ
 * (hàng còn ở kho, nằm trong kiện). Giá mỗi SKU là bình quân giá các dòng xuất của SKU đó trong lượt; giá vốn bình quân
 * tính lại. Mỗi SKU đảo không quá số đã xuất trong lượt; đảo xong thì lượt hết, gọi lại là lỗi.
 */
export async function reverseShipment(
  packageId: string,
  lines: readonly StockLine[],
  opts: { actorId: string; reason: string },
): Promise<DocumentRef> {
  const wanted = mergeLines(lines);
  if (!wanted.size) throw new Error(`Kiện ${packageId} đảo bàn giao không có dòng hàng`);
  const reason = opts.reason.trim();
  if (!reason || reason.length > REASON_MAX) throw new Error(`Lý do đảo bàn giao kiện ${packageId} phải có và không quá ${REASON_MAX} ký tự`);
  await lockLevels([...wanted.keys()]);

  const round = activeRound(await packageShipments(packageId));
  if (!round.length) throw new Error(`Kiện ${packageId} không có lượt bàn giao nào để đảo`);
  const shipped = round.flatMap((d) => d.lines);
  const costOf = new Map<string, string>();
  for (const [variantId, q] of wanted) {
    const ofSku = shipped.filter((l) => l.variantId === variantId);
    const total = ofSku.reduce((n, l) => n + l.quantity, 0);
    if (q > total) throw new Error(`Kiện ${packageId} đảo ${q} cái ${variantId} nhưng lượt bàn giao chỉ xuất ${total}`);
    costOf.set(variantId, averageCost(ofSku).toFixed(2));
  }

  const { ref, lineIdOf } = await createSystemDocument({
    kind: 'shipment_reversal',
    status: 'posted',
    sourceType: 'package',
    sourceId: packageId,
    actorId: opts.actorId,
    note: reason,
    reason,
    lines: [...wanted].map(([variantId, quantity]) => ({ variantId, quantity, expectedQty: null, unitCost: costOf.get(variantId)! })),
  });
  await applyChange({
    source: { type: 'stock_document', id: ref.documentId },
    moves: [...wanted].map(
      ([variantId, q]): Move => ({ variantId, bucket: 'on_hand', qty: q, unitCost: costOf.get(variantId)!, sourceLineId: lineIdOf.get(variantId)! }),
    ),
    reserved: wanted,
    actorId: opts.actorId,
  });
  return ref;
}
