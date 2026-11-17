// Trạng thái ghép SKU của dòng đơn/kiện (spec 237): có biến thể (ghép), "không quản tồn" (ghép không giữ), hoặc chưa ghép.
export type LineSku = { kind: 'variant'; variantId: string } | { kind: 'untracked' } | { kind: 'unmapped' };

/** Ghép thật: có biến thể hoặc "không quản tồn". */
export type MappedSku = Exclude<LineSku, { kind: 'unmapped' }>;

export const lineSkuOf = (l: { variantId: string | null; stockUntracked: boolean }): LineSku =>
  l.variantId ? { kind: 'variant', variantId: l.variantId } : l.stockUntracked ? { kind: 'untracked' } : { kind: 'unmapped' };

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
