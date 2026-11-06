// Giữ và nhả hàng cho kiện (Documents/21 mục 11.1, spec #206 mục 5.5). Chạy trong giao dịch của bên gọi. Chống gọi lặp
// ở fulfillment (Q11): khoá kiện, đổi `reserved_qty` có điều kiện; inventory cộng trừ đúng số được truyền. Đang giữ không
// ghi thẻ kho, không phát `stock_changed` (Q15).
import { mergeLines, type StockLine } from '../domain/documents.ts';
import { availableQty } from '../domain/stock.ts';
import { lockedOf } from './locked.ts';
import { applyChange } from './posting.ts';

/** Giữ nguyên kiện: mọi SKU đủ có thể bán thì giữ hết, thiếu một SKU thì không giữ gì (`reserved: false`). */
export async function reserve(_packageId: string, lines: readonly StockLine[]): Promise<{ reserved: boolean }> {
  const wanted = mergeLines(lines);
  if (!wanted.size) return { reserved: true };
  const reserved = await applyChange({ source: null, moves: [], reserved: wanted, actorId: null }, (locked) =>
    [...wanted].every(([id, q]) => {
      const level = locked.get(id)!;
      return availableQty(level.onHand, level.reserved, lockedOf(id)) >= q;
    }),
  );
  return { reserved };
}

/** Trả phần đang giữ của kiện. Nhả quá số đang giữ là hai bên lệch sổ: lỗi lập trình kèm mã kiện, không ghi gì. */
export async function release(packageId: string, lines: readonly StockLine[]): Promise<void> {
  const held = mergeLines(lines);
  if (!held.size) return;
  const over: string[] = [];
  const released = await applyChange(
    { source: null, moves: [], reserved: new Map([...held].map(([id, q]) => [id, -q])), actorId: null },
    (locked) => {
      for (const [id, q] of held) if (locked.get(id)!.reserved < q) over.push(id);
      return !over.length;
    },
  );
  if (!released) throw new Error(`Kiện ${packageId} nhả quá số đang giữ: ${over.join(', ')}`);
}
