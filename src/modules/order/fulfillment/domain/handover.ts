// Luật thuần của bàn giao trừ tồn (spec 199a §5.2, Documents/21 §11.1, Documents/25 §6.1, §8.1). Một chỗ thi hành là
// `service/handover-stock.ts`; mọi đường vào (kho quét, sàn báo, hàm bù, dòng ghép SKU muộn) đi qua đó.
import { isHandedOver, type PackageStatus } from './package.ts';

/** Ai đưa kiện vào nhóm rời kho; cùng giá trị enum `order.handover_source`. */
export type HandoverSource = 'scan' | 'marketplace' | 'forced' | 'before_cutoff';

export type StockEffect = 'ship' | 'reverse' | 'none';

/**
 * Tác động lên tồn của mũi tên `from → to` (`from` null: kiện mới tạo). Vào nhóm rời kho thì trừ (bàn giao, tự giao,
 * sàn nhảy cóc, kiện mới đã rời kho); ra khỏi nhóm thì đảo (chỉ huỷ bàn giao). Hàng hoàn không cộng tồn ở đây.
 */
export function stockEffectOf(from: PackageStatus | null, to: PackageStatus): StockEffect {
  const wasOut = from !== null && isHandedOver(from);
  if (isHandedOver(to) && !wasOut) return 'ship';
  if (wasOut && !isHandedOver(to)) return 'reverse';
  return 'none';
}

export type HandoverStockMode = 'deduct' | 'store_only' | 'defer';

/**
 * Cách xử lý tồn khi kiện rời kho:
 * - gian hàng chờ kiểm kê đầu kỳ → `defer` (hàm bù `settleDeferredHandovers` xử lý khi phiếu đầu kỳ ghi sổ);
 * - kiện lần đầu thấy, đơn đặt trước mốc kéo đơn → `store_only` (đã rời kho trước mốc, kiểm kê đã tính);
 * - còn lại → `deduct`, kể cả đơn về muộn đặt sau mốc (25 §8.1).
 */
export function handoverStockMode(p: {
  firstSeen: boolean;
  placedAt: Date;
  orderCutoffAt: Date | null;
  awaitingStocktake: boolean;
}): HandoverStockMode {
  if (p.awaitingStocktake) return 'defer';
  if (p.firstSeen && p.orderCutoffAt && p.placedAt < p.orderCutoffAt) return 'store_only';
  return 'deduct';
}

export interface PlanLine {
  id: string;
  variantId: string | null;
  quantity: number;
  reservedQty: number;
  stockDeducted: boolean;
}

/**
 * Dòng cần trừ: đã ghép SKU, chưa trừ. `held` đã giữ đủ, `unheld` chưa giữ (phải thử giữ, không được thì bàn giao bắt
 * buộc). Hai nhóm rỗng nghĩa là đã trừ hết: chốt "trừ đúng một lần".
 */
export function shipPlan(lines: readonly PlanLine[]): { held: PlanLine[]; unheld: PlanLine[] } {
  const due = lines.filter((l) => l.variantId !== null && !l.stockDeducted);
  return { held: due.filter((l) => l.reservedQty === l.quantity), unheld: due.filter((l) => l.reservedQty < l.quantity) };
}

const PICKUP_GRACE_MS = 24 * 60 * 60 * 1000;

/** Cờ `pickup_unconfirmed` (21 §19.2): kho quét, còn ở nhóm rời kho, sàn chưa xác nhận lấy sau 24 giờ. Suy ra, không lưu. */
export function pickupUnconfirmed(
  p: { status: PackageStatus; handoverSource: HandoverSource | null; pickupConfirmedAt: Date | null; handedOverAt: Date | null },
  now: number,
): boolean {
  return (
    isHandedOver(p.status) &&
    p.handoverSource === 'scan' &&
    p.pickupConfirmedAt === null &&
    p.handedOverAt !== null &&
    p.handedOverAt.getTime() <= now - PICKUP_GRACE_MS
  );
}
