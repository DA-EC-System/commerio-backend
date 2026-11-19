// Áp ghép SKU lên đơn đã về (spec 237 §5.4): channel gọi trong giao dịch ghép (`listings/match`, `mapping/approve`), đã
// khoá dòng gian hàng nên không có đơn mới, không có kiện của gian hàng rời kho trong lúc áp. Mọi việc trên kiện, tồn do
// fulfillment (`remapPackageLines`); sales ghi dòng đơn và phát sự kiện đơn.
import { publishEvent } from '../../../core/index.ts';
import { logger } from '../../../../shared/logger.ts';
import { type MappedSku, remapPackageLines } from '../../fulfillment/index.ts';
import { findOrderRows, lockUnmappedLinesOfShopSku, setOrderLineSku } from '../repository/orders.ts';
import { eventFlags } from './ingest.ts';

export interface ApplySkuMappingInput {
  shopId: string;
  /** SKU người bán trên sàn (`order_lines.external_sku`). */
  sellerSku: string;
  /** Ghép có hiệu lực của dòng thắng theo SKU người bán. */
  to: MappedSku;
  /** Người làm bước có hiệu lực (người ghép, hoặc CEO duyệt). */
  actorId: string;
  /** Gian hàng không chờ kiểm kê đầu kỳ. */
  holdStock: boolean;
  orderCutoffAt: Date | null;
}

/**
 * Gán ghép cho mọi dòng **chưa ghép** của đơn cùng gian hàng mang SKU người bán này (P1), trong giao dịch và
 * `withCompany` của bên gọi. Dòng đơn đổi khi mọi dòng kiện của nó `applied` (hoặc không có dòng kiện); đơn `unpaid`,
 * `processing` có dòng đổi phát `sales.order_status_changed` (`from = to`) kèm cờ mới (P6). Gọi lại khi đã áp xong không
 * chọn dòng nào: không ghi, không phát. Lỗi nào cũng ném để cả giao dịch ghép rollback.
 */
export async function applySkuMapping(input: ApplySkuMappingInput): Promise<{ lines: number; orders: number; needsUnload: number }> {
  const { shopId, sellerSku, to } = input;
  const locked = await lockUnmappedLinesOfShopSku(shopId, sellerSku);
  if (!locked.length) return { lines: 0, orders: 0, needsUnload: 0 };

  const outcomes = await remapPackageLines(
    locked.map((l) => ({ orderLineId: l.id, to })),
    { actorId: input.actorId, holdStock: input.holdStock, orderCutoffAt: input.orderCutoffAt, reason: `Ghép SKU ${sellerSku}` },
  );
  const changed = locked.filter((l) => (outcomes.get(l.id) ?? 'applied') === 'applied');
  const needsUnload = locked.filter((l) => outcomes.get(l.id) === 'needs_unload').length;
  await setOrderLineSku(
    changed.map((l) => l.id),
    to,
    sellerSku,
  );

  const orderIds = [...new Set(changed.map((l) => l.orderId))];
  for (const row of await findOrderRows(orderIds)) {
    if (row.status !== 'unpaid' && row.status !== 'processing') continue;
    const flags = await eventFlags(row.id, row);
    await publishEvent({
      type: 'sales.order_status_changed',
      aggregateId: row.id,
      payload: { orderId: row.id, code: row.code, from: row.status, to: row.status, flags },
    });
  }

  const result = { lines: changed.length, orders: orderIds.length, needsUnload };
  logger.info({ shopId, sellerSku, ...result }, 'áp ghép SKU lên đơn đã về');
  return result;
}
