// Bàn giao theo kiện (Documents/21 mục 11.1, spec #206 mục 5.5). Chạy trong giao dịch của bên gọi; fulfillment khoá kiện
// trước khi gọi và chặn gọi lặp bằng `stock_deducted` (Q12). Thứ tự khoá: dòng tồn theo `variantId` → `doc_counters`.
import { activeRound, type DocumentRef, mergeLines, sameLines, type StockLine } from '../domain/documents.ts';
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
    // Kiểm trước khi lấy số phiếu: bộ đếm không bị đụng kể cả khi bên gọi bắt lỗi trong savepoint (Q21).
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
