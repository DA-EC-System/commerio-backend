// Giữ và nhả hàng cho kiện (Documents/21 mục 11.1, spec #206 mục 5.5). Chạy trong giao dịch của bên gọi. Chống gọi lặp
// ở fulfillment (Q11): khoá kiện, đổi `reserved_qty` có điều kiện; inventory cộng trừ đúng số được truyền. Đang giữ không
// ghi thẻ kho, không phát `stock_changed` (Q15).
import { mergeLines, type StockLine } from '../domain/documents.ts';
import { availableQty } from '../domain/stock.ts';
import { levelsOf } from '../repository/levels.ts';
import { lockedOf } from './locked.ts';
import { applyChange, assertOwnVariants } from './posting.ts';

/** Giữ nguyên kiện: mọi SKU đủ có thể bán thì giữ hết, thiếu một SKU thì không giữ gì (`reserved: false`). */
export async function reserve(_packageId: string, lines: readonly StockLine[]): Promise<{ reserved: boolean }> {
  const wanted = mergeLines(lines);
  if (!wanted.size) return { reserved: true };
  // SKU chưa có dòng tồn thì có thể bán 0: trả false mà không tạo dòng, để `reorderVersion` của SKU mới không đổi (Q24).
  const ids = [...wanted.keys()];
  if ((await levelsOf(ids)).size < ids.length) {
    await assertOwnVariants(ids);
    return { reserved: false };
  }
  // Tạm khoá đọc trước khi khoá dòng tồn: `precheck` chạy đồng bộ sau khi khoá (#208, phiếu kho chờ duyệt)
  const locks = await lockedOf(ids);
  const reserved = await applyChange({ source: null, moves: [], reserved: wanted, actorId: null }, (locked) =>
    [...wanted].every(([id, q]) => {
      const level = locked.get(id)!;
      return availableQty(level.onHand, level.reserved, locks.get(id) ?? 0) >= q;
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
