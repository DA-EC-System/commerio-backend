// Luật thuần của phiếu do hệ thống lập theo kiện (spec #206): số phiếu (Q18), gộp dòng, lưới gọi lặp `ship` theo id
// dòng kiện (Q12), lượt đang xuất (Q17).

/** Một dòng hàng của kiện truyền vào cổng tồn (Documents/21 mục 11.1). */
export interface StockLine {
  variantId: string;
  quantity: number;
}

/** Phiếu kho cổng trả về cho bên gọi. */
export interface DocumentRef {
  documentId: string;
  number: string;
}

/** Tiền tố số phiếu theo loại; mỗi loại một bộ đếm `doc_counters` (`KH-` là kiện, `KK-` kiểm kê, `PX-` mô hình cũ). */
export const DOC_PREFIX = { shipment: 'XK', shipment_reversal: 'DX', return_inspection: 'KT' } as const;
export type SystemDocKind = keyof typeof DOC_PREFIX;

/** `XK-000001`: tiền tố, gạch nối, số đệm 0 tới 6 chữ số. */
export const docNumber = (prefix: string, n: number) => `${prefix}-${String(n).padStart(6, '0')}`;

/**
 * Gộp số lượng theo SKU. `quantity` không phải số nguyên dương là bên gọi vi phạm hợp đồng (route của bên gọi đã kiểm
 * bằng Zod): ném lỗi lập trình kèm SKU.
 */
export function mergeLines(lines: readonly StockLine[]): Map<string, number> {
  const merged = new Map<string, number>();
  for (const l of lines) {
    if (!Number.isInteger(l.quantity) || l.quantity <= 0) throw new Error(`Số lượng của ${l.variantId} phải là số nguyên dương: ${l.quantity}`);
    merged.set(l.variantId, (merged.get(l.variantId) ?? 0) + l.quantity);
  }
  return merged;
}

/** Dòng của `ship`: dòng kiện (`"order".package_lines`) cùng SKU và số lượng (spec #206 Q12). */
export interface ShipLine extends StockLine {
  packageLineId: string;
}

export type ShipmentMatch<T> = { kind: 'new' } | { kind: 'repeat'; doc: T } | { kind: 'conflict'; lineIds: string[] };

/**
 * Lưới gọi lặp `ship` (Q12): so id dòng kiện của lần gọi với các phiếu xuất trong lượt đang xuất. Không dòng nào đã trừ
 * thì là lần mới (dòng ghép SKU sau trùng SKU, số với lần trước vẫn là lần mới); đúng tập dòng của một phiếu thì là gọi
 * lặp; còn lại là bên gọi sai (lẫn dòng đã trừ, thiếu dòng của phiếu, trải nhiều phiếu).
 */
export function matchShipment<T extends { lineIds: readonly string[] }>(round: readonly T[], requested: readonly string[]): ShipmentMatch<T> {
  const wanted = new Set(requested);
  const touched = round.filter((d) => d.lineIds.some((id) => wanted.has(id)));
  if (!touched.length) return { kind: 'new' };
  const [only] = touched;
  if (touched.length === 1 && only!.lineIds.length === wanted.size && only!.lineIds.every((id) => wanted.has(id))) {
    return { kind: 'repeat', doc: only! };
  }
  return { kind: 'conflict', lineIds: touched.flatMap((d) => d.lineIds.filter((id) => wanted.has(id))) };
}

/**
 * Lượt đang xuất của kiện: các phiếu `shipment` lập sau phiếu `shipment_reversal` gần nhất. `docs` là mọi phiếu xuất,
 * phiếu đảo của kiện, đã sắp theo thời điểm lập.
 */
export function activeRound<T extends { kind: 'shipment' | 'shipment_reversal' }>(docs: readonly T[]): T[] {
  const lastReversal = docs.findLastIndex((d) => d.kind === 'shipment_reversal');
  return docs.slice(lastReversal + 1).filter((d) => d.kind === 'shipment');
}
