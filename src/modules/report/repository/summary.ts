// Đọc, ghi `report.daily_channel_summary`. Chạy trong `withCompany` của bên gọi (RLS theo công ty).
import { and, between, eq, sql } from 'drizzle-orm';
import { getDb } from '../../../shared/db/client.ts';
import type { SummaryRow } from '../domain/summary.ts';
import { dailyChannelSummary } from './schema.ts';

/** Khoá tính lại của một công ty tới hết giao dịch: hai lần tính lại cùng công ty chạy lần lượt (plan #29 A4). */
export async function lockCompanySummary(companyId: string): Promise<void> {
  await getDb().execute(sql`select pg_advisory_xact_lock(hashtextextended(${`report.summary:${companyId}`}, 0))`);
}

/** Thay mọi dòng của công ty trong [from, to] bằng `rows` (số đã làm tròn tới đồng). */
export async function replaceDays(companyId: string, from: string, to: string, rows: readonly SummaryRow[]): Promise<void> {
  await getDb()
    .delete(dailyChannelSummary)
    .where(and(eq(dailyChannelSummary.companyId, companyId), between(dailyChannelSummary.day, from, to)));
  if (rows.length === 0) return;
  await getDb()
    .insert(dailyChannelSummary)
    .values(
      rows.map((r) => ({
        companyId,
        day: r.day,
        source: r.source,
        shopId: r.shopId,
        revenue: r.revenue.toFixed(2),
        cashCollected: r.cashCollected.toFixed(2),
        platformFee: r.platformFee.toFixed(2),
        paymentFee: r.paymentFee.toFixed(2),
        shippingFee: r.shippingFee.toFixed(2),
        cogs: r.cogs.toFixed(2),
        profit: r.profit.toFixed(2),
        feesPending: r.feesPending,
      })),
    );
}
