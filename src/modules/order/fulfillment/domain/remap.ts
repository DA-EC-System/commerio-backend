// Trạng thái ghép SKU của dòng đơn/kiện (spec 237): có biến thể (ghép), "không quản tồn" (ghép không giữ), hoặc chưa ghép.
// Luật thuần áp ghép lên kiện đã có (`planRemap`, spec 237 §5.5 bảng 1, P1–P3); thi hành ở `service/remap.ts`.
import type { HandoverSource } from './handover.ts';
import { HANDED_OVER, HOLDING, type PackageStatus } from './package.ts';

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
  lines: readonly {
    id: string;
    orderLineId: string;
    variantId: string | null;
    stockUntracked: boolean;
    quantity: number;
    reservedQty: number;
    stockDeducted: boolean;
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
}

const NONE: RemapStock = { kind: 'none' };

/**
 * Áp ghép lên các dòng của một kiện (spec 237 §5.5 bảng 1). PR 1 chỉ ghép lần đầu (P1): dòng kiện đã ghép khác `to` giữ
 * nguyên (`kept`); đã đúng `to` thì `applied` không ghi. `changes` theo `orderLineId`.
 */
export function planRemap(
  pkg: RemapPackage,
  changes: ReadonlyMap<string, MappedSku>,
  opts: { holdStock: boolean; orderCutoffAt: Date | null },
): RemapPlan {
  const writes: RemapPlan['writes'] = [];
  const outcomes = new Map<string, RemapOutcome>();
  for (const l of pkg.lines) {
    const to = changes.get(l.orderLineId);
    if (!to) continue;
    const from = lineSkuOf(l);
    if (sameSku(from, to)) outcomes.set(l.id, 'applied');
    else if (from.kind !== 'unmapped') outcomes.set(l.id, 'kept');
    else {
      writes.push({ lineId: l.id, to });
      outcomes.set(l.id, 'applied');
    }
  }
  return { writes, outcomes, stock: stockStep(pkg, writes, opts), reportDelivered: pkg.status === 'delivered' && writes.length > 0 };
}

function stockStep(pkg: RemapPackage, writes: RemapPlan['writes'], opts: { holdStock: boolean; orderCutoffAt: Date | null }): RemapStock {
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
  if (status === 'backordered') {
    if (nothingToHold(after)) return { kind: 'hold' };
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
