// Lý do chặn lưu trữ SKU phần kho (#204, Documents/21 §17.3): catalog nhận hàm này qua `ctx` (product/index.ts) và gọi
// trong giao dịch lưu trữ của mình.
import { openDocumentCounts } from '../repository/archive-blockers.ts';
import { type LevelRow, levelsOf, lockLevel } from '../repository/levels.ts';

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
    if (onHand) reasons.push(`Còn ${onHand} tồn thực`);
    if (reserved) reasons.push(`Đang giữ ${reserved} cho đơn`);
    if (quarantine) reasons.push(`Còn ${quarantine} chờ xử lý`);
    const open = docs.get(id) ?? 0;
    if (open) reasons.push(`Còn ${open} phiếu kho chưa ghi sổ`);
    if (reasons.length) result.set(id, reasons);
  }
  return result;
}
