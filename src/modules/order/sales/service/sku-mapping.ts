// Áp ghép SKU lên đơn đã về (spec 237 §5.4): channel gọi trong giao dịch ghép (`listings/match`, `mapping/approve`), đã
// khoá dòng gian hàng nên không có đơn mới, không có kiện của gian hàng rời kho trong lúc áp. Mọi việc trên kiện, tồn do
// fulfillment (`remapPackageLines`); sales ghi dòng đơn và phát sự kiện đơn.
import { publishEvent } from '../../../core/index.ts';
import { logger } from '../../../../shared/logger.ts';
import { type LineSku, lineSkuOf, type MappedSku, remapPackageLines } from '../../fulfillment/index.ts';
import { findOrderLinesByIds, findOrderRows, lockLinesToRemap, lockOrderLinesById, setOrderLineSku } from '../repository/orders.ts';
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
 * Áp ghép cho dòng đơn của gian hàng mang SKU người bán này (spec 237 §5.4), trong giao dịch và `withCompany` của bên
 * gọi: dòng chưa ghép ở mọi đơn; dòng đã ghép khác (đổi ghép) và dòng có dòng kiện chờ đổi ghép (D27) ở đơn còn mở.
 * Dòng đơn đổi khi mọi dòng kiện tính kết quả của nó `applied` (hoặc không có dòng kiện) và ghép đang có khác `to`; đơn
 * `unpaid`, `processing` có dòng đổi phát `sales.order_status_changed` (`from = to`) kèm cờ mới (P6). Gọi lại khi đã áp
 * xong không ghi, không phát. Lỗi nào cũng ném để cả giao dịch ghép rollback.
 */
export async function applySkuMapping(input: ApplySkuMappingInput): Promise<{ lines: number; orders: number; needsUnload: number }> {
  const { shopId, sellerSku, to } = input;
  const locked = await lockLinesToRemap(shopId, sellerSku, to);
  if (!locked.length) return { lines: 0, orders: 0, needsUnload: 0 };

  const outcomes = await remapPackageLines(
    locked.map((l) => ({ orderLineId: l.id, to })),
    { actorId: input.actorId, holdStock: input.holdStock, orderCutoffAt: input.orderCutoffAt, reason: `Ghép SKU ${sellerSku}` },
  );
  // Dòng đơn đã bằng `to` (chọn vì dấu, D27) không ghi: `version` giữ.
  const changed = locked.filter((l) => (outcomes.get(l.id) ?? 'applied') === 'applied' && !sameMappedSku(lineSkuOf(l), to));
  const needsUnload = locked.filter((l) => outcomes.get(l.id) === 'needs_unload').length;
  await setOrderLineSku(
    changed.map((l) => l.id),
    to,
  );

  const orderIds = [...new Set(changed.map((l) => l.orderId))];
  await publishOrdersChanged(orderIds);

  const result = { lines: changed.length, orders: orderIds.length, needsUnload };
  logger.info({ shopId, sellerSku, ...result }, 'áp ghép SKU lên đơn đã về');
  return result;
}

const sameMappedSku = (a: LineSku, b: MappedSku) =>
  a.kind === b.kind && (a.kind !== 'variant' || a.variantId === (b as { variantId: string }).variantId);

/** Khoá dòng đơn theo id cho fulfillment mở kiện áp lại ghép (spec 237 D21), tiêm qua `order/index.ts`. */
export const lockOrderLines = (ids: readonly string[]): Promise<void> => lockOrderLinesById(ids);

/**
 * Ghi ghép lên dòng đơn sau khi fulfillment mở kiện áp lại ghép (spec 237 §5.6, §5.4 bước 3, 4): gom theo đích, phát sự
 * kiện đơn cho đơn có dòng đổi. Bên gọi đã khoá dòng đơn (`lockOrderLines`).
 */
export async function applyLineSkus(rows: readonly { orderLineId: string; to: MappedSku }[]): Promise<void> {
  if (!rows.length) return;
  const groups = new Map<string, { to: MappedSku; ids: string[] }>();
  for (const r of rows) {
    const key = r.to.kind === 'variant' ? r.to.variantId : r.to.kind;
    const group = groups.get(key) ?? { to: r.to, ids: [] };
    group.ids.push(r.orderLineId);
    groups.set(key, group);
  }
  for (const { to, ids } of groups.values()) await setOrderLineSku(ids, to);
  const lines = await findOrderLinesByIds(rows.map((r) => r.orderLineId));
  await publishOrdersChanged([...new Set(lines.map((l) => l.orderId))]);
}

/**
 * Đơn `unpaid`, `processing` vừa có dòng đổi ghép: phát `sales.order_status_changed` (`from = to`) kèm cờ mới như ingest
 * (P6), để FE tải lại qua SSE. Đơn đã dừng không phát.
 */
export async function publishOrdersChanged(orderIds: readonly string[]): Promise<void> {
  for (const row of await findOrderRows(orderIds)) {
    if (row.status !== 'unpaid' && row.status !== 'processing') continue;
    const flags = await eventFlags(row.id, row);
    await publishEvent({
      type: 'sales.order_status_changed',
      aggregateId: row.id,
      payload: { orderId: row.id, code: row.code, from: row.status, to: row.status, flags },
    });
  }
}
