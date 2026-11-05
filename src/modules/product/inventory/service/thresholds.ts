// Cảnh báo dưới ngưỡng (V31, Documents/25 mục 7.5): xét lại mỗi khi một con số trong điều kiện ngưỡng đổi. Chạy trong
// giao dịch của bên gọi; khoá dòng tồn nên hai giao dịch cùng xét một SKU không cùng báo.
import { publishEvent } from '../../../core/index.ts';
import { getVariants } from '../../catalog/index.ts';
import { availableQty, nextAlertState } from '../domain/stock.ts';
import { lockExistingLevels, setAlertActive } from '../repository/levels.ts';
import { lockedOf } from './port.ts';
import type { IncomingLookup } from './views.ts';

let incomingSource: IncomingLookup | null = null;

/** `product/index.ts` nối số đang về của purchasing lúc nạp module (purchasing import inventory nên không import ngược). */
export function setIncomingSource(source: IncomingLookup): void {
  incomingSource = source;
}

/**
 * Xét lại ngưỡng của các SKU: vừa chạm ngưỡng thì bật cờ và phát `inventory.below_threshold` một lần; lên trên ngưỡng,
 * bỏ ngưỡng, SKU ngừng bán hoặc lưu trữ thì tắt cờ. Gọi lại nhiều lần không báo trùng.
 */
export async function recheckThresholds(variantIds: readonly string[]): Promise<void> {
  const ids = [...new Set(variantIds)].sort();
  const levels = (await lockExistingLevels(ids)).filter((l) => l.minQty !== null || l.alertActive);
  if (!levels.length) return;
  if (!incomingSource) throw new Error('Chưa nối số đang về của purchasing (setIncomingSource ở src/modules/product/index.ts)');
  const watched = levels.map((l) => l.variantId);
  const variants = new Map((await getVariants(watched)).map((v) => [v.id, v]));
  const incoming = await incomingSource(watched);
  for (const level of levels) {
    const variant = variants.get(level.variantId);
    if (!variant) continue;
    const available = availableQty(level.onHand, level.reserved, lockedOf(level.variantId));
    const next = nextAlertState({
      available,
      incoming: incoming.get(level.variantId) ?? 0,
      // shortcut: còn thiếu cho đơn bằng 0 tới khi có kiện thiếu hàng (#106), như `toStockLevel`.
      shortage: 0,
      minQty: level.minQty,
      businessStatus: variant.businessStatus,
      alertActive: level.alertActive,
    });
    if (next.alertActive !== level.alertActive) await setAlertActive(level.variantId, next.alertActive);
    if (next.fire) {
      await publishEvent({
        type: 'inventory.below_threshold',
        aggregateId: level.variantId,
        payload: { variantId: level.variantId, available, minQty: level.minQty! },
      });
    }
  }
}
