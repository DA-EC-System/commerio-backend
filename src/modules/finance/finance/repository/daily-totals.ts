// Tổng theo ngày (giờ VN) và đơn cho báo cáo (#29). Chạy trong `withCompany` của bên gọi: RLS chỉ cho thấy công ty đó.
import { sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { inVnDays, vnDayOf as vnDay } from '../../../../shared/db/vn-time.ts';

export type FinanceDayRow = {
  day: string;
  order_id: string;
  revenue: string;
  invoice_net: number;
  cash_collected: string;
  refunded: string;
};

/**
 * Một dòng mỗi (ngày, đơn): hoá đơn (gốc và đảo, kể cả gốc đã `reversed`), phiếu thu có đơn, phiếu chi hoàn tiền khách
 * không nháp. `invoice_net` = số hoá đơn gốc − số hoá đơn đảo trong ngày (đếm theo `reversal_of_id`, không theo dấu).
 */
export async function financeDays(from: string, to: string): Promise<FinanceDayRow[]> {
  const result = await getDb().execute<FinanceDayRow>(sql`
    with docs as (
      select ${vnDay(sql`issued_at`)} as day, order_id, total as revenue,
             case when reversal_of_id is null then 1 else -1 end as invoice_net, 0::numeric as cash, 0::numeric as refunded
        from finance.sales_invoices where ${inVnDays(sql`issued_at`, from, to)}
      union all
      select ${vnDay(sql`posted_at`)}, order_id, 0, 0, amount, 0
        from finance.receipts where order_id is not null and ${inVnDays(sql`posted_at`, from, to)}
      union all
      select to_char(paid_on, 'YYYY-MM-DD'), order_id, 0, 0, 0, amount
        from finance.payment_vouchers
       where purpose = 'customer_refund' and status <> 'draft' and order_id is not null
         and paid_on between ${from}::date and ${to}::date
    )
    select day, order_id, sum(revenue)::text as revenue, sum(invoice_net)::int as invoice_net,
           sum(cash)::text as cash_collected, sum(refunded)::text as refunded
      from docs group by day, order_id order by day, order_id`);
  return result.rows;
}

export type SettlementRow = {
  order_id: string;
  platform_fee: string;
  shipping_cost: string;
};

/** Phí sàn (Σ mọi ô của `fees`) và chi phí vận chuyển sàn của từng đơn, cộng qua mọi dòng đối soát `order`. */
export async function settlementByOrder(orderIds: readonly string[]): Promise<SettlementRow[]> {
  if (orderIds.length === 0) return [];
  const result = await getDb().execute<SettlementRow>(sql`
    select l.order_id, coalesce(sum(f.total), 0)::text as platform_fee, sum(l.shipping_cost)::text as shipping_cost
      from finance.settlement_lines l
      left join lateral (select sum(value::numeric) as total from jsonb_each_text(l.fees)) f on true
     where l.kind = 'order' and l.order_id in (${sql.join(orderIds.map((id) => sql`${id}::uuid`), sql`, `)})
     group by l.order_id`);
  return result.rows;
}
