// Phí cổng theo ngày (giờ VN) và đơn cho báo cáo (#29). Chạy trong `withCompany` của bên gọi.
import { sql } from 'drizzle-orm';
import { getDb } from '../../../shared/db/client.ts';
import { inVnDays, vnDayOf } from '../../../shared/db/vn-time.ts';

export async function feesByDay(from: string, to: string) {
  const result = await getDb().execute<{ day: string; order_id: string; fee: string }>(sql`
    select ${vnDayOf(sql`occurred_at`)} as day, order_id, sum(fee)::text as fee
      from payment.payment_transactions
     where status = 'succeeded' and fee is not null and order_id is not null
       and ${inVnDays(sql`occurred_at`, from, to)}
     group by 1, 2 order by 1, 2`);
  return result.rows;
}
