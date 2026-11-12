// Bàn giao và đảo bàn giao theo kiện (Documents/21 mục 11.1, spec #206 mục 5.5). Chạy trong giao dịch của bên gọi;
// fulfillment khoá kiện trước khi gọi và chặn gọi lặp bằng `stock_deducted` (Q12). Thứ tự khoá: dòng tồn theo
// `variantId` → `doc_counters`.
import { activeRound, type DocumentRef, matchShipment, mergeLines, type ShipLine, type StockLine } from '../domain/documents.ts';
import { averageCost } from '../domain/stock.ts';
import { packageShipments } from '../repository/documents.ts';
import { createSystemDocument } from './system-documents.ts';
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
 * Lập phiếu xuất `XK` đã ghi sổ theo giá vốn bình quân lúc khoá, mỗi dòng kiện một dòng phiếu, trừ tồn thực; bàn giao
 * thường trừ cả đang giữ. Trong lượt đang xuất (Q17) đã có phiếu đúng tập dòng kiện này thì trả phiếu đó, không trừ lần
 * nữa; lẫn dòng kiện đã trừ với dòng mới là lỗi của bên gọi (Q12).
 */
export async function ship(packageId: string, lines: readonly ShipLine[], opts: ShipOptions): Promise<DocumentRef> {
  const wanted = mergeLines(lines);
  if (!wanted.size) throw new Error(`Kiện ${packageId} bàn giao không có dòng hàng`);
  const lineIds = lines.map((l) => l.packageLineId);
  const repeated = [...new Set(lineIds.filter((id, i) => lineIds.indexOf(id) !== i))];
  if (repeated.length) throw new Error(`Kiện ${packageId} có dòng kiện lặp trong một lần bàn giao: ${repeated.join(', ')}`);
  const levels = await lockLevels([...wanted.keys()]);

  // Lưới gọi lặp (Q12): đọc sau khi khoá dòng tồn, nên lần gọi trùng chạy song song thấy phiếu đã commit.
  const round = activeRound(await packageShipments(packageId)).map((d) => ({
    ...d,
    lineIds: d.lines.flatMap((l) => (l.sourceLineId ? [l.sourceLineId] : [])),
  }));
  const match = matchShipment(round, lineIds);
  if (match.kind === 'repeat') return { documentId: match.doc.id, number: match.doc.number };
  if (match.kind === 'conflict') {
    throw new Error(`Kiện ${packageId}: dòng kiện ${match.lineIds.join(', ')} đã bàn giao trong lượt này; gọi lại phải đúng tập dòng của phiếu cũ`);
  }

  const forced = opts.forced === true;
  if (!forced) {
    // Kiểm trước khi lấy số phiếu (Q21): bên gọi bắt lỗi mà vẫn commit thì bộ đếm không nhảy số, và đường lỗi không
    // giữ khoá dòng đếm `doc_counters` (khoá chung của mọi `ship` trong công ty).
    const unheld = [...wanted].filter(([id, q]) => levels.get(id)!.reserved < q).map(([id]) => id);
    if (unheld.length) throw new Error(`Kiện ${packageId} chưa giữ hàng (${unheld.join(', ')}); bàn giao bắt buộc thì truyền forced`);
  }

  const costOf = (variantId: string) => levels.get(variantId)!.avgCost;
  const created = await createSystemDocument({
    kind: 'shipment',
    status: 'posted',
    sourceType: 'package',
    sourceId: packageId,
    actorId: opts.actorId,
    note: forced ? FORCED_NOTE : null,
    lines: lines.map((l) => ({
      variantId: l.variantId,
      quantity: l.quantity,
      expectedQty: null,
      unitCost: costOf(l.variantId),
      sourceLineId: l.packageLineId,
    })),
  });
  const ref = created.ref;
  const docLineOf = new Map(created.lines.map((d) => [d.sourceLineId!, d.id]));
  await applyChange({
    source: { type: 'stock_document', id: ref.documentId },
    moves: lines.map(
      (l): Move => ({
        variantId: l.variantId,
        bucket: 'on_hand',
        qty: -l.quantity,
        unitCost: costOf(l.variantId),
        sourceLineId: docLineOf.get(l.packageLineId)!,
      }),
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
 * tính lại. Huỷ bàn giao nhầm là cả kiện quay về chờ lấy hàng, không đảo một phần: `lines` phải gồm đúng mọi SKU của
 * lượt với đúng tổng đã xuất, lệch là lỗi lập trình. Đảo xong thì lượt hết, gọi lại là lỗi.
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
  // Đảo xong thì lượt hết (`activeRound`), nên đảo thiếu để lại phần đã trừ tồn mà không còn cách đảo: mỗi SKU của lượt
  // phải đảo đúng tổng đã xuất, không thừa SKU nào.
  const totals = mergeLines(shipped);
  const mismatched = [...new Set([...totals.keys(), ...wanted.keys()])]
    .filter((v) => (totals.get(v) ?? 0) !== (wanted.get(v) ?? 0))
    .map((v) => `${v} đã xuất ${totals.get(v) ?? 0}, đảo ${wanted.get(v) ?? 0}`);
  if (mismatched.length) throw new Error(`Kiện ${packageId} phải đảo đủ cả lượt bàn giao: ${mismatched.join('; ')}`);
  const costOf = new Map(
    [...wanted.keys()].map((v) => [v, averageCost(shipped.filter((l) => l.variantId === v)).toFixed(2)] as const),
  );

  const { ref, lines: docLines } = await createSystemDocument({
    kind: 'shipment_reversal',
    status: 'posted',
    sourceType: 'package',
    sourceId: packageId,
    actorId: opts.actorId,
    note: reason,
    reason,
    lines: [...wanted].map(([variantId, quantity]) => ({
      variantId,
      quantity,
      expectedQty: null,
      unitCost: costOf.get(variantId)!,
      sourceLineId: null,
    })),
  });
  const lineIdOf = new Map(docLines.map((d) => [d.variantId, d.id]));
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
