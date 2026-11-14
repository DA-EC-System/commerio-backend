// Luật chia kiện (spec 205 §5.2, D2, D8, D12): kiện cũ giữ phần còn lại, mỗi phần của `parts` thành một kiện mới.
// Thuần, không I/O. Dòng vào đã sắp theo `created_at, id` như `planLinesOf`.

/** Mức tách kiện của sàn (`capabilities.splitLevel` của channel): `unit` chia từng món, `sku` chỉ chia trọn SKU. */
export type SplitLevel = 'unit' | 'sku' | 'none';

export interface SplitLine {
  id: string;
  orderLineId: string;
  /** null: dòng chưa ghép SKU, luôn ở lại kiện cũ (D2). */
  variantId: string | null;
  quantity: number;
  reservedQty: number;
}

export interface SplitPart {
  variantId: string;
  quantity: number;
}

/** `quantity` nhỏ hơn số lượng của dòng: chỉ chuyển một phần dòng (D12). */
export interface LineMove {
  lineId: string;
  quantity: number;
}

export type SplitPlan =
  /** `moves[i]` ứng với kiện mới thứ i, theo thứ tự `parts`. */
  | { ok: true; moves: LineMove[][] }
  | { ok: false; code: 'validation_failed'; errors: Record<string, string> }
  | { ok: false; code: 'split_not_supported'; message: string };

export const SPLIT_MESSAGES = {
  unknownVariant: 'SKU không có trong kiện',
  overflow: 'Vượt số lượng trong kiện',
  oldEmpty: 'Kiện cũ phải còn ít nhất một món',
  skuOnly: 'Sàn chỉ cho tách theo SKU, không tách đôi cùng một SKU',
} as const;

export function planSplit(lines: readonly SplitLine[], parts: readonly (readonly SplitPart[])[], level: 'unit' | 'sku'): SplitPlan {
  const inPackage = new Map<string, number>();
  for (const line of lines) {
    if (line.variantId !== null) inPackage.set(line.variantId, (inPackage.get(line.variantId) ?? 0) + line.quantity);
  }

  const errors: Record<string, string> = {};
  const asked = new Map<string, number>();
  parts.forEach((part, i) => part.forEach((item, j) => {
    const available = inPackage.get(item.variantId);
    if (available === undefined) {
      errors[`parts.${i}.${j}.variantId`] = SPLIT_MESSAGES.unknownVariant;
      return;
    }
    const total = (asked.get(item.variantId) ?? 0) + item.quantity;
    asked.set(item.variantId, total);
    if (total > available) errors[`parts.${i}.${j}.quantity`] = SPLIT_MESSAGES.overflow;
  }));
  if (Object.keys(errors).length) return { ok: false, code: 'validation_failed', errors };

  const all = lines.reduce((sum, line) => sum + line.quantity, 0);
  const moved = [...asked.values()].reduce((sum, quantity) => sum + quantity, 0);
  if (all - moved <= 0) return { ok: false, code: 'validation_failed', errors: { parts: SPLIT_MESSAGES.oldEmpty } };

  if (level === 'sku') {
    const partsOf = new Map<string, number>();
    for (const part of parts) {
      for (const variantId of new Set(part.map((item) => item.variantId))) partsOf.set(variantId, (partsOf.get(variantId) ?? 0) + 1);
    }
    const halved = [...asked].some(([variantId, quantity]) => (partsOf.get(variantId) ?? 0) > 1 || quantity !== inPackage.get(variantId));
    if (halved) return { ok: false, code: 'split_not_supported', message: SPLIT_MESSAGES.skuOnly };
  }

  const left = new Map(lines.map((line) => [line.id, line.quantity]));
  const moves = parts.map((part) => {
    const out: LineMove[] = [];
    for (const item of part) {
      let need = item.quantity;
      for (const line of lines) {
        if (need === 0) break;
        const free = left.get(line.id)!;
        if (line.variantId !== item.variantId || free === 0) continue;
        const take = Math.min(free, need);
        left.set(line.id, free - take);
        need -= take;
        const last = out.at(-1);
        if (last?.lineId === line.id) last.quantity += take;
        else out.push({ lineId: line.id, quantity: take });
      }
    }
    return out;
  });
  return { ok: true, moves };
}

/**
 * Chia một dòng khi chỉ chuyển một phần (D12). Phần giữ theo nguyên dòng (CHECK `package_lines_reserved_whole`): dòng
 * đang giữ thì cả hai nửa đều giữ đủ, dòng chưa giữ thì cả hai bằng 0.
 */
export function carveLine(line: Pick<SplitLine, 'quantity' | 'reservedQty'>, moved: number) {
  const held = line.reservedQty > 0;
  const keep = line.quantity - moved;
  return {
    keep: { quantity: keep, reservedQty: held ? keep : 0 },
    moved: { quantity: moved, reservedQty: held ? moved : 0 },
  };
}
