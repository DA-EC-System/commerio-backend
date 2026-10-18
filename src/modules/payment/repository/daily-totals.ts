// Phí cổng theo ngày (giờ VN) và đơn cho báo cáo (#29). Chạy trong `withCompany` của bên gọi.
import { sql } from 'drizzle-orm';
import { getDb } from '../../../shared/db/client.ts';

export async function feesByDay(from: string, to: string) {
  const result = await getDb().execute<{ day: string; order_id: string; fee: string }>(sql`
    select to_char(occurred_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') as day, order_id, sum(fee)::text as fee
      from payment.payment_transactions
     where status = 'succeeded' and fee is not null and order_id is not null
       and occurred_at >= (${from}::date::timestamp at time zone 'Asia/Ho_Chi_Minh')
       and occurred_at < ((${to}::date + 1)::timestamp at time zone 'Asia/Ho_Chi_Minh')
     group by 1, 2 order by 1, 2`);
  return result.rows;
}
