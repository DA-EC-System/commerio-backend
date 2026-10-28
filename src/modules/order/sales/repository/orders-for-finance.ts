// Đọc đơn cho finance (#27 A2). Chỉ schema sales: đơn, dòng đơn, khách; không join chéo schema.
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { customers, orderLines, orders } from './schema.ts';

export async function findOrderLines(orderId: string) {
  return getDb()
    .select({
      id: orderLines.id,
      variantId: orderLines.variantId,
      sku: orderLines.sku,
      productName: orderLines.productName,
      quantity: orderLines.quantity,
      unitPrice: orderLines.unitPrice,
      lineTotal: orderLines.lineTotal,
    })
    .from(orderLines)
    .where(eq(orderLines.orderId, orderId))
    .orderBy(orderLines.createdAt, orderLines.id);
}

export async function findOrdersForFinance(ids: readonly string[]) {
  return getDb()
    .select({
      id: orders.id,
      code: orders.code,
      status: orders.status,
      source: orders.source,
      paymentMethod: orders.paymentMethod,
      total: orders.total,
      customerName: customers.name,
      customerPhone: customers.phone,
    })
    .from(orders)
    .leftJoin(customers, eq(customers.id, orders.customerId))
    .where(inArray(orders.id, [...ids]));
}

export async function findOrdersByExternalId(shopId: string, externalOrderIds: readonly string[]) {
  return getDb()
    .select({ id: orders.id, externalOrderId: orders.externalOrderId, total: orders.total })
    .from(orders)
    .where(and(eq(orders.shopId, shopId), inArray(orders.externalOrderId, [...externalOrderIds])));
}
