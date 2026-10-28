// Giá vốn đã giao của đơn, tính từ dòng kiện đã trừ tồn (giá vốn chốt lúc bàn giao, 25 §7.1). Chạy trong `withCompany`.
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { packageLines, packages } from './schema.ts';

export async function sumCogsByOrder(orderIds: readonly string[]): Promise<{ orderId: string; cogs: string }[]> {
  return getDb()
    .select({ orderId: packages.orderId, cogs: sql<string>`sum(${packageLines.quantity} * ${packageLines.unitCost})` })
    .from(packageLines)
    .innerJoin(packages, eq(packages.id, packageLines.packageId))
    .where(and(inArray(packages.orderId, [...orderIds]), eq(packageLines.stockDeducted, true)))
    .groupBy(packages.orderId);
}
