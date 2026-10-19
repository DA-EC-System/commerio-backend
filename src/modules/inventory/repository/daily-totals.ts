// Giá vốn theo đơn cho báo cáo (#29). Chạy trong `withCompany` của bên gọi.
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../../shared/db/client.ts';
import { stockIssueLines, stockIssues } from './schema.ts';

/** Σ `quantity × unit_cost` của phiếu xuất theo đơn đã ghi sổ (`done`), mỗi đơn một dòng. */
export async function cogsByOrder(orderIds: readonly string[]) {
  if (orderIds.length === 0) return [];
  return getDb()
    .select({
      orderId: sql<string>`${stockIssues.orderId}`,
      cogs: sql<string>`sum(${stockIssueLines.quantity} * ${stockIssueLines.unitCost})::text`,
    })
    .from(stockIssues)
    .innerJoin(stockIssueLines, eq(stockIssueLines.issueId, stockIssues.id))
    .where(and(eq(stockIssues.kind, 'order'), eq(stockIssues.status, 'done'), inArray(stockIssues.orderId, [...orderIds])))
    .groupBy(stockIssues.orderId);
}
