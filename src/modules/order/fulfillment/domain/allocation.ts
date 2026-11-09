// Luật thuần của phân hàng cho kiện (Documents/25 §7.4, spec 199b §5.2): thứ tự xét kiện, chọn kiện giữ được, chọn kiện
// bị lấy lại phần giữ. Giữ nguyên kiện, không giữ từng phần. Không I/O.
import type { PackageStatus } from './package.ts';

export interface StockLine {
  variantId: string;
  quantity: number;
}

export interface AllocationCandidate {
  id: string;
  code: string;
  status: PackageStatus;
  shipBy: Date | null;
  orderCreatedAt: Date;
  lines: StockLine[];
}

export interface ReclaimCandidate {
  id: string;
  orderStatus: 'unpaid' | 'processing';
  reservedAt: Date | null;
  lines: StockLine[];
}

/** Số cần theo SKU của các dòng (Lazada mỗi món một dòng: gộp lại). */
export function needOf(lines: readonly StockLine[]): Map<string, number> {
  const need = new Map<string, number>();
  for (const l of lines) need.set(l.variantId, (need.get(l.variantId) ?? 0) + l.quantity);
  return need;
}

const time = (d: Date | null) => (d === null ? Infinity : d.valueOf());

/**
 * Thứ tự xét: kiện đã đóng mà chưa giữ trước (hàng đã trong hộp, spec 199b D5), rồi hạn chuẩn bị sớm (null cuối), rồi
 * đơn kéo về trước, rồi mã kiện.
 */
export function allocationQueue<T extends AllocationCandidate>(candidates: readonly T[]): T[] {
  const sealed = (c: AllocationCandidate) => (c.status === 'backordered' ? 1 : 0);
  return [...candidates].sort(
    (a, b) =>
      sealed(a) - sealed(b) ||
      time(a.shipBy) - time(b.shipBy) ||
      a.orderCreatedAt.valueOf() - b.orderCreatedAt.valueOf() ||
      a.code.localeCompare(b.code),
  );
}

/** Đi lần lượt theo hàng đợi: kiện nào mọi SKU đủ thì chọn và trừ vào bản đếm tạm; thiếu thì bỏ qua, xét kiện sau. */
export function planAllocation<T extends AllocationCandidate>(queue: readonly T[], available: ReadonlyMap<string, number>): T[] {
  const left = new Map(available);
  const chosen: T[] = [];
  for (const c of queue) {
    const need = needOf(c.lines);
    if (![...need].every(([v, q]) => (left.get(v) ?? 0) >= q)) continue;
    for (const [v, q] of need) left.set(v, (left.get(v) ?? 0) - q);
    chosen.push(c);
  }
  return chosen;
}

/**
 * `deficits`: SKU → đang giữ − tồn thực (> 0). Đơn `unpaid` trước `processing`; trong nhóm kiện giữ sau cùng trước
 * (`reservedAt` null cuối), rồi `id`. Lấy cả kiện có SKU còn thiếu, dừng khi hết thiếu.
 */
export function planReclaim<T extends ReclaimCandidate>(deficits: ReadonlyMap<string, number>, candidates: readonly T[]): T[] {
  const left = new Map([...deficits].filter(([, q]) => q > 0));
  const group = (c: ReclaimCandidate) => (c.orderStatus === 'unpaid' ? 0 : 1);
  const recent = (d: Date | null) => (d === null ? -Infinity : d.valueOf());
  const ordered = [...candidates].sort(
    (a, b) => group(a) - group(b) || recent(b.reservedAt) - recent(a.reservedAt) || a.id.localeCompare(b.id),
  );
  const chosen: T[] = [];
  for (const c of ordered) {
    if (!left.size) break;
    const need = needOf(c.lines);
    if (![...need.keys()].some((v) => left.has(v))) continue;
    for (const [v, q] of need) {
      if (!left.has(v)) continue;
      const rest = left.get(v)! - q;
      if (rest > 0) left.set(v, rest);
      else left.delete(v);
    }
    chosen.push(c);
  }
  return chosen;
}
