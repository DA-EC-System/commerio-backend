// Trạng thái ghép SKU của dòng đơn/kiện (spec 237): có biến thể (ghép), "không quản tồn" (ghép không giữ), hoặc chưa ghép.
// Luật thuần áp ghép lên kiện đã có (`planRemap`, spec 237 §5.5 bảng 1, 2, 3 và §5.6); thi hành ở `service/remap.ts`.
// - Bảng 1 (ghép lần đầu, P1–P3): dòng chưa ghép nhận ghép mới ở mọi trạng thái kiện.
// - Bảng 2 (đổi ghép A → B hay "không quản tồn"): kiện chưa đóng nhả A, ghi dòng; kiện đã đóng đánh dấu `remap_pending`,
//   bật Cần mở `remap` (D15–D17), mở ra mới áp; kiện huỷ, dòng chờ bỏ không tính; kiện đã rời kho giữ ghép cũ.
// - Bảng 3 ("không quản tồn" → B): kiện chưa rời kho ghi dòng như bảng 1, kể cả kiện đã đóng (món trong hộp đã đúng).
// - Dòng chờ thay của kiện thay giữ ghép cũ (D26); đổi về như cũ xoá dấu, hết dấu thì `remap` sang `stocktake` (D24).
import type { HandoverSource } from './handover.ts';
import { type OpenPurpose, raisePurpose } from './open-purpose.ts';
import { HANDED_OVER, HOLDING, isSealed, type PackageStatus } from './package.ts';

export type LineSku = { kind: 'variant'; variantId: string } | { kind: 'untracked' } | { kind: 'unmapped' };

/** Ghép thật: có biến thể hoặc "không quản tồn". */
export type MappedSku = Exclude<LineSku, { kind: 'unmapped' }>;

export const lineSkuOf = (l: { variantId: string | null; stockUntracked: boolean }): LineSku =>
  l.variantId ? { kind: 'variant', variantId: l.variantId } : l.stockUntracked ? { kind: 'untracked' } : { kind: 'unmapped' };

const sameSku = (a: LineSku, b: LineSku) =>
  a.kind === b.kind && (a.kind !== 'variant' || a.variantId === (b as { variantId: string }).variantId);

/**
 * Kiện không còn gì để giữ (spec 237 D10): không dòng chưa ghép, và mọi dòng có biến thể đã giữ đủ. Dòng "không quản tồn"
 * không giữ, không trừ. `MappedSku` ở đây: mọi dòng đều phải có biến thể (kiện "chưa ghép" có dòng `unmapped`/`untracked`).
 */
export function nothingToHold(
  lines: readonly { variantId: string | null; stockUntracked: boolean; reservedQty: number; quantity: number }[],
): boolean {
  return lines.every((l) => {
    if (lineSkuOf(l).kind === 'unmapped') return false;
    if (l.variantId === null) return true; // untracked
    return l.reservedQty >= l.quantity;
  });
}

/** Kiện đã khoá cùng các dòng, đủ để quyết việc trên tồn khi áp ghép. */
export interface RemapPackage {
  status: PackageStatus;
  handedOverAt: Date | null;
  handoverSource: HandoverSource | null;
  needsOpen: boolean;
  openPurpose: OpenPurpose | null;
  lines: readonly {
    id: string;
    orderLineId: string;
    variantId: string | null;
    stockUntracked: boolean;
    quantity: number;
    reservedQty: number;
    stockDeducted: boolean;
    /** Dòng chờ bỏ (`> 0`) không tính khi đổi ghép (§5.4). */
    pendingDropQty: number;
    /** Dòng của kiện đã đóng đang chờ áp ghép mới (§5.6). */
    remapPending: boolean;
  }[];
}

/** `applied`: dòng kiện mang ghép mới (hoặc đã mang sẵn); `kept`: giữ ghép cũ; `needs_unload`: chờ dỡ kiện (PR 2). */
export type RemapOutcome = 'applied' | 'kept' | 'needs_unload';

export type RemapStock =
  | { kind: 'none' }
  /** Kiện `backordered` không còn gì để giữ: sang `reserved` (mũi tên `hold`), không gọi cổng tồn. */
  | { kind: 'hold' }
  /** Xếp lượt phân hàng cho các biến thể. */
  | { kind: 'allocate'; variantIds: string[] }
  /** Giữ dòng vừa có biến thể của kiện đang giữ hàng (P2); `sealed`: kiện đã đóng gói. Chỉ khi `holdStock`. */
  | { kind: 'reserve_new'; lineIds: string[]; sealed: boolean }
  /** Kiện `reserved` có dòng mới mà gian hàng chờ kiểm kê: nhả, về `backordered`, không xếp lượt. */
  | { kind: 'reclaim' }
  /** Kiện đã rời kho: trừ dòng vừa ghép (`shipLateMappedLines`). */
  | { kind: 'ship' }
  /** Kiện rời kho trước mốc, chưa dòng nào trừ: ghi `before_cutoff`, không trừ (P3, D11). */
  | { kind: 'store_only' };

export interface RemapPlan {
  /** Dòng kiện ghi trạng thái ghép mới. */
  writes: { lineId: string; to: MappedSku }[];
  /** Kết quả theo dòng kiện (mọi dòng có trong `changes`). */
  outcomes: Map<string, RemapOutcome>;
  /** Việc trên kiện sau khi ghi, theo thứ tự thi hành. */
  stock: RemapStock;
  /** Kiện `delivered`: gọi `reportDelivered` sau bước tồn. */
  reportDelivered: boolean;
  /** Dòng đổi ghép (bảng 2) đang giữ theo biến thể cũ: nhả trước khi ghi dòng. */
  releases: { lineId: string; variantId: string; quantity: number }[];
  /** Dòng của kiện đã đóng bật dấu chờ đổi ghép (bảng 2). */
  marks: string[];
  /** Dòng có dấu mà ghép đã về đúng như món trong hộp: xoá dấu. */
  unmarks: string[];
  /** Cờ Cần mở cần ghi (D17, D24); null: giữ cờ đang có. */
  purpose: { needsOpen: true; openPurpose: OpenPurpose } | null;
  /** Biến thể xếp lượt phân hàng thêm (biến thể vừa nhả, D24), đã sắp, không trùng. */
  allocateAlso: string[];
}

const NONE: RemapStock = { kind: 'none' };

const sorted = (ids: Iterable<string>) => [...new Set(ids)].sort();

/**
 * Áp ghép lên các dòng của một kiện (spec 237 §5.5 bảng 1, 2, 3; §5.6). `changes` theo `orderLineId`. `awaitingLineIds`:
 * dòng chờ thay của kiện thay (#238), giữ ghép cũ (D26). Dòng kiện không có trong `outcomes` thì không tính vào kết quả
 * của dòng đơn (kiện huỷ, dòng chờ bỏ khi đổi ghép, §5.4).
 */
export function planRemap(
  pkg: RemapPackage,
  changes: ReadonlyMap<string, MappedSku>,
  opts: { holdStock: boolean; orderCutoffAt: Date | null; awaitingLineIds?: ReadonlySet<string> },
): RemapPlan {
  const awaiting = opts.awaitingLineIds ?? new Set<string>();
  const sealed = isSealed(pkg.status);
  const writes: RemapPlan['writes'] = [];
  const releases: RemapPlan['releases'] = [];
  const marks: string[] = [];
  const unmarks: string[] = [];
  const outcomes = new Map<string, RemapOutcome>();
  let unload = false;
  for (const l of pkg.lines) {
    const to = changes.get(l.orderLineId);
    if (!to) continue;
    const from = lineSkuOf(l);
    if (awaiting.has(l.id)) {
      outcomes.set(l.id, 'kept');
    } else if (sameSku(from, to)) {
      outcomes.set(l.id, 'applied');
      if (l.remapPending && sealed) unmarks.push(l.id);
    } else if (from.kind === 'unmapped') {
      // Bảng 1: ghép lần đầu, mọi trạng thái kiện, kể cả dòng chờ bỏ.
      writes.push({ lineId: l.id, to });
      outcomes.set(l.id, 'applied');
    } else if (l.pendingDropQty > 0 || pkg.status === 'cancelled') {
      // Không tính (§5.4): dòng chờ bỏ rời kiện khi mở, kiện huỷ không còn món.
    } else if (HANDED_OVER.includes(pkg.status)) {
      outcomes.set(l.id, 'kept');
    } else if (from.kind === 'variant' && sealed) {
      // Bảng 2, kiện đã đóng: hộp chứa món theo ghép cũ, chờ dỡ (D4, D15, D16).
      outcomes.set(l.id, 'needs_unload');
      unload = true;
      if (!l.remapPending) marks.push(l.id);
    } else {
      // Bảng 2 kiện `backordered`/`reserved`; bảng 3 ("không quản tồn" → B) kiện chưa rời kho.
      if (from.kind === 'variant' && l.reservedQty > 0 && opts.holdStock) {
        releases.push({ lineId: l.id, variantId: from.variantId, quantity: l.reservedQty });
      }
      writes.push({ lineId: l.id, to });
      outcomes.set(l.id, 'applied');
    }
  }

  let purpose: RemapPlan['purpose'] = unload ? raisePurpose(pkg, 'remap') : null;
  const allocateAlso = releases.map((r) => r.variantId);
  // D24: kiện `remap` hết dấu (đổi về như cũ) chuyển sang `stocktake` và xếp lượt, không gỡ thẳng.
  const stillMarked = pkg.lines.some((l) => (l.remapPending && !unmarks.includes(l.id)) || marks.includes(l.id));
  if (sealed && pkg.needsOpen && pkg.openPurpose === 'remap' && !stillMarked) {
    purpose = { needsOpen: true, openPurpose: 'stocktake' };
    allocateAlso.push(...pkg.lines.flatMap((l) => (l.variantId ? [l.variantId] : [])));
  }

  const released = new Set(releases.map((r) => r.lineId));
  const base = { ...pkg, lines: pkg.lines.map((l) => (released.has(l.id) ? { ...l, reservedQty: 0 } : l)) };
  const awaitingInPackage = pkg.lines.some((l) => awaiting.has(l.id));
  return {
    writes,
    outcomes,
    stock: stockStep(base, writes, opts, awaitingInPackage),
    reportDelivered: pkg.status === 'delivered' && writes.length > 0,
    releases,
    marks,
    unmarks,
    purpose,
    allocateAlso: sorted(allocateAlso),
  };
}

function stockStep(
  pkg: RemapPackage,
  writes: RemapPlan['writes'],
  opts: { holdStock: boolean; orderCutoffAt: Date | null },
  awaitingReplacement: boolean,
): RemapStock {
  if (!writes.length) return NONE;
  const written = new Map(writes.map((w) => [w.lineId, w.to]));
  const after = pkg.lines.map((l) => {
    const to = written.get(l.id);
    return to ? { ...l, variantId: to.kind === 'variant' ? to.variantId : null, stockUntracked: to.kind === 'untracked' } : l;
  });
  const variantIds = () => [...new Set(after.flatMap((l) => (l.variantId ? [l.variantId] : [])))].sort();
  const fresh = writes.filter((w) => w.to.kind === 'variant').map((w) => w.lineId);
  const { status } = pkg;

  // Kiện có thể vừa đủ điều kiện giữ; kiện toàn dòng "không quản tồn" lượt phân hàng không tìm thấy nên `hold` ngay (D10).
  // Kiện chờ thay không `hold` trong lúc áp (D26): dòng chờ thay sẽ nhận phần giữ của dòng chờ bỏ ở kiện cũ.
  if (status === 'backordered') {
    if (!awaitingReplacement && nothingToHold(after)) return { kind: 'hold' };
    const ids = variantIds();
    return ids.length ? { kind: 'allocate', variantIds: ids } : NONE;
  }
  if (HOLDING.includes(status)) {
    const sealed = status !== 'reserved';
    // Chờ kiểm kê: không gọi cổng tồn; lượt phiếu đầu kỳ `{ all: true }` sẽ giữ.
    if (!opts.holdStock) return sealed || !fresh.length ? NONE : { kind: 'reclaim' };
    // Kiện đã đóng chưa giữ dòng nào (lập lúc còn dòng chưa ghép): lượt giữ nguyên kiện, không giữ lẻ một dòng (P2). Dòng
    // chưa ghép cuối sang "không quản tồn" cũng làm kiện vừa đủ điều kiện giữ (review I1).
    if (sealed && !pkg.lines.some((l) => l.reservedQty > 0)) {
      const ids = variantIds();
      const eligible = fresh.length > 0 || after.every((l) => lineSkuOf(l).kind !== 'unmapped');
      return eligible && ids.length ? { kind: 'allocate', variantIds: ids } : NONE;
    }
    return fresh.length ? { kind: 'reserve_new', lineIds: fresh, sealed } : NONE;
  }
  if (!fresh.length) return NONE;
  if (status === 'returned' || !HANDED_OVER.includes(status)) return NONE;
  // Chờ kiểm kê: `settleDeferredHandovers` trừ khi phiếu đầu kỳ ghi sổ (D8). Kiện đã mang mốc: hàm trừ tự bỏ qua.
  if (!opts.holdStock || pkg.handoverSource === 'before_cutoff') return NONE;
  const beforeCutoff = opts.orderCutoffAt !== null && pkg.handedOverAt !== null && pkg.handedOverAt < opts.orderCutoffAt;
  if (beforeCutoff && !pkg.lines.some((l) => l.stockDeducted)) return { kind: 'store_only' };
  return { kind: 'ship' };
}
