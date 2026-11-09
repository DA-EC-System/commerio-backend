// Một chỗ thi hành tác động tồn của bàn giao (spec 199a §5.3, Documents/21 §11.1). Mọi đường vào (kho quét, sàn báo,
// hàm bù cho #198, dòng ghép SKU muộn cho #237) đi qua đây. Chạy trong giao dịch của bên gọi; kiện đã khoá `FOR UPDATE`.
// Chốt "trừ đúng một lần": `stock_deducted` của dòng (đổi trong cùng giao dịch) và lưới `packageLineId` của `ship`.
import { publishEvent } from '../../../core/index.ts';
import { logger } from '../../../../shared/logger.ts';
import { type HandoverStockMode, type PlanLine, shipPlan } from '../domain/handover.ts';
import { isHandedOver } from '../domain/package.ts';
import {
  type HandoverPackage,
  lockDeferredPackages,
  lockPackage,
  markLinesReserved,
  markLinesReverted,
  markLinesShipped,
  updatePackage,
} from '../repository/packages.ts';
import { type DocumentRef, type ShipLine, stockPort } from './stock-port.ts';

export const FORCED_HANDOVER_NOTE = 'Bàn giao bắt buộc: thiếu tồn, cần kiểm kê lại';

const shipLines = (lines: readonly PlanLine[]): ShipLine[] =>
  lines.map((l) => ({ variantId: l.variantId!, quantity: l.quantity, packageLineId: l.id }));

/**
 * Trừ tồn cho các dòng chưa trừ của kiện vừa (hoặc đã) rời kho.
 * - `store_only`: kiện rời kho trước mốc, ghi `before_cutoff`, không trừ. `defer`: chờ kiểm kê đầu kỳ, không làm gì.
 * - Dòng chưa giữ thì thử giữ; không giữ được thì bàn giao bắt buộc (`forced`, tồn thực có thể âm, kiện Cần xử lý).
 * - Mỗi dòng vừa trừ chốt giá vốn bình quân lúc đó; phát `fulfillment.package_shipped`.
 * Cập nhật `pkg` tại chỗ để bên gọi đọc tiếp.
 */
export async function settleHandover(
  pkg: HandoverPackage,
  opts: { actorId: string | null; mode: HandoverStockMode },
): Promise<{ documents: DocumentRef[] }> {
  if (opts.mode === 'defer') return { documents: [] };
  if (opts.mode === 'store_only') {
    await updatePackage(pkg.id, { handoverSource: 'before_cutoff' });
    pkg.handoverSource = 'before_cutoff';
    return { documents: [] };
  }

  const { held, unheld } = shipPlan(pkg.lines);
  if (!held.length && !unheld.length) return { documents: [] };

  const port = stockPort();
  let forced: PlanLine[] = [];
  if (unheld.length) {
    const { reserved } = await port.reserve(pkg.id, shipLines(unheld));
    if (reserved) {
      await markLinesReserved(unheld.map((l) => l.id));
      for (const l of unheld) l.reservedQty = l.quantity;
      held.push(...unheld);
    } else forced = unheld;
  }

  const documents: DocumentRef[] = [];
  if (held.length) documents.push(await port.ship(pkg.id, shipLines(held), { actorId: opts.actorId }));
  if (forced.length) {
    documents.push(await port.ship(pkg.id, shipLines(forced), { actorId: opts.actorId, forced: true }));
    await updatePackage(pkg.id, { handoverSource: 'forced', needsAttention: true, flagNote: FORCED_HANDOVER_NOTE });
    pkg.handoverSource = 'forced';
    pkg.needsAttention = true;
    logger.warn({ packageId: pkg.id, variantIds: [...new Set(forced.map((l) => l.variantId))] }, 'bàn giao bắt buộc: thiếu tồn');
  }

  const shipped = [...held, ...forced];
  const stock = await port.stockOf([...new Set(shipped.map((l) => l.variantId!))]);
  const costOf = (l: PlanLine) => stock.get(l.variantId!)!.avgCost;
  await markLinesShipped(shipped.map((l) => ({ id: l.id, unitCost: costOf(l) })));
  for (const l of shipped) {
    l.stockDeducted = true;
    l.reservedQty = 0;
  }
  await publishEvent({
    type: 'fulfillment.package_shipped',
    aggregateId: pkg.orderId,
    payload: {
      packageId: pkg.id,
      orderId: pkg.orderId,
      lines: shipped.map((l) => ({ variantId: l.variantId!, quantity: l.quantity, unitCost: costOf(l) })),
    },
  });
  return { documents };
}

/**
 * Hàm bù khi phiếu kiểm kê đầu kỳ của gian hàng ghi sổ (#198 gọi trong giao dịch ghi sổ hoặc ngay sau): kiện đã rời
 * kho lúc chờ kiểm kê (`defer`) thì rời kho từ `countedAt` trở đi trừ tồn, trước đó ghi `before_cutoff` (kiểm kê đã
 * tính). Gọi lần hai không trừ thêm: kiện đã trừ hết dòng hoặc đã `before_cutoff` không còn được chọn.
 */
export async function settleDeferredHandovers(shopId: string, countedAt: Date): Promise<{ deducted: number; storedOnly: number }> {
  const result = { deducted: 0, storedOnly: 0 };
  for (const pkg of await lockDeferredPackages(shopId)) {
    const deduct = pkg.handedOverAt !== null && pkg.handedOverAt >= countedAt;
    await settleHandover(pkg, { actorId: null, mode: deduct ? 'deduct' : 'store_only' });
    result[deduct ? 'deducted' : 'storedOnly']++;
  }
  return result;
}

/**
 * Trừ tồn cho dòng vừa ghép SKU muộn của kiện đã rời kho (#237 gọi sau khi gán `variant_id`). Kiện chưa rời kho (chia
 * hàng lo) hoặc `before_cutoff` thì không làm gì. Trả các phiếu `XK` vừa lập.
 */
export async function shipLateMappedLines(packageId: string): Promise<DocumentRef[]> {
  const pkg = await lockPackage(packageId);
  if (!pkg || !isHandedOver(pkg.status) || pkg.handoverSource === 'before_cutoff') return [];
  return (await settleHandover(pkg, { actorId: null, mode: 'deduct' })).documents;
}

/**
 * Huỷ bàn giao nhầm: đảo đủ cả lượt (phiếu `DX`, cộng lại tồn thực và đang giữ), dòng giữ hàng lại, kiện về chờ lấy
 * hàng và xoá mốc bàn giao, ghi người huỷ. Đổi trạng thái cùng câu với xoá mốc vì CHECK `packages_handed_over`,
 * `packages_handover_source`. Bên gọi ghi lịch sử, phát sự kiện.
 */
export async function revertHandover(pkg: HandoverPackage, actorId: string, reason: string): Promise<DocumentRef | null> {
  const deducted = pkg.lines.filter((l) => l.stockDeducted);
  const document = deducted.length
    ? await stockPort().reverseShipment(
        pkg.id,
        deducted.map((l) => ({ variantId: l.variantId!, quantity: l.quantity })),
        { actorId, reason },
      )
    : null;
  await markLinesReverted(deducted.map((l) => l.id));
  for (const l of deducted) {
    l.reservedQty = l.quantity;
    l.stockDeducted = false;
  }
  await updatePackage(pkg.id, {
    status: 'awaiting_pickup',
    handoverSource: null,
    handedOverAt: null,
    handedOverBy: null,
    pickupConfirmedAt: null,
    handoverRevertedBy: actorId,
  });
  pkg.status = 'awaiting_pickup';
  pkg.handoverSource = null;
  pkg.handedOverAt = null;
  pkg.pickupConfirmedAt = null;
  return document;
}
