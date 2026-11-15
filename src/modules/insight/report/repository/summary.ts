// Đọc `insight.daily_channel_summary`. Chạy trong `withCompany` của bên gọi (RLS theo công ty).
import { and, between, eq } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import type { OrderSource } from '../domain/summary.ts';
import { dailyChannelSummary } from './schema.ts';

/** Dòng của công ty trong [from, to], lọc tuỳ chọn theo nguồn, gian hàng; kèm thời điểm tính lại gần nhất (`asOf`). */
export async function readDays(
  from: string,
  to: string,
  filter: { source?: OrderSource | undefined; shopId?: string | undefined } = {},
) {
  const t = dailyChannelSummary;
  return getDb()
    .select({
      day: t.day,
      source: t.source,
      shopId: t.shopId,
      revenue: t.revenue,
      cashCollected: t.cashCollected,
      platformFee: t.platformFee,
      paymentFee: t.paymentFee,
      shippingFee: t.shippingFee,
      cogs: t.cogs,
      feesPending: t.feesPending,
      updatedAt: t.updatedAt,
    })
    .from(t)
    .where(
      and(
        between(t.day, from, to),
        filter.source ? eq(t.source, filter.source) : undefined,
        filter.shopId ? eq(t.shopId, filter.shopId) : undefined,
      ),
    );
}
