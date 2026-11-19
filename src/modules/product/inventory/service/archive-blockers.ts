// Lý do chặn lưu trữ SKU phần kho (#204, Documents/21 §17.3): catalog nhận hàm này qua `ctx` (product/index.ts) và gọi
// trong giao dịch lưu trữ của mình.
import { openDocumentCounts, usedVariants } from '../repository/archive-blockers.ts';
import { deleteLevels, type LevelRow, levelsOf, lockLevel } from '../repository/levels.ts';

/**
 * Câu lý do theo SKU: tồn thực, đang giữ, chờ xử lý khác 0, phiếu kho nháp hoặc chờ duyệt. SKU không vướng gì thì không
 * có trong Map.
 *
 * `lock` (thao tác lưu trữ): khoá dòng tồn (tạo dòng 0 nếu chưa có) theo `variantId` tăng dần như lõi ghi sổ, giữ tới hết
 * giao dịch của bên gọi, nên ghi sổ kho không chen được giữa lúc kiểm và lúc lưu trữ (spec 204 D10). Không đi qua
 * `lockLevels` của service vì hàm đó gọi lại catalog; id do catalog đưa vào đã là SKU của công ty. Không `lock` (xem chi
 * tiết sản phẩm): chỉ đọc, không tạo dòng.
 */
export async function stockArchiveBlockers(
  variantIds: readonly string[],
  { lock = false }: { lock?: boolean } = {},
): Promise<Map<string, string[]>> {
  const ids = [...new Set(variantIds)].sort();
  if (!ids.length) return new Map();
  const levels = new Map<string, Pick<LevelRow, 'onHand' | 'reserved' | 'quarantine'>>();
  if (lock) {
    for (const id of ids) levels.set(id, await lockLevel(id));
  } else {
    for (const [id, level] of await levelsOf(ids)) levels.set(id, level);
  }
  const docs = await openDocumentCounts(ids);
  const result = new Map<string, string[]>();
  for (const id of ids) {
    const { onHand, reserved, quarantine } = levels.get(id) ?? { onHand: 0, reserved: 0, quarantine: 0 };
    const reasons: string[] = [];
    if (onHand) reasons.push(`Còn ${onHand} tồn kho`);
    if (reserved) reasons.push(`Tạm giữ ${reserved} cho đơn`);
    if (quarantine) reasons.push(`Còn ${quarantine} hàng lỗi/chờ kiểm`);
    const open = docs.get(id) ?? 0;
    if (open) reasons.push(`Còn ${open} phiếu kho chưa hoàn thành`);
    if (reasons.length) result.set(id, reasons);
  }
  return result;
}

/** SKU đã có thẻ kho hoặc nằm trên phiếu kho (mọi trạng thái): catalog không xoá hẳn sản phẩm có SKU này (#204). */
export async function stockInUse(variantIds: readonly string[]): Promise<Set<string>> {
  return usedVariants([...new Set(variantIds)]);
}

/** Catalog xoá hẳn sản phẩm (#204): xoá dòng tồn của SKU chưa dùng (`stockInUse` rỗng), trong giao dịch của catalog. */
export async function deleteStockLevels(variantIds: readonly string[]): Promise<void> {
  await deleteLevels([...new Set(variantIds)].sort());
}
