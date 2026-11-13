// Lãi theo SKU (#231; Documents/21 §21.1, 25 §10.2 "Báo cáo theo kỳ: Lãi gộp theo đơn, SKU…"): gộp bằng SQL trên dòng
// hàng của kiện đã giao (`ledger_package_lines`) và sổ của các đơn đó, không kéo sổ lên bộ nhớ.
import { not, type SQL, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { NON_CASH } from '../domain/ledger.ts';
import { isReplaced } from './ledger.ts';
import { ledgerEntries, ledgerPackageLines } from './schema.ts';

export interface SkuProfitFilter {
  /** Ngày giao của dòng hàng (giờ Việt Nam) từ ngày này, gồm. */
  from: string;
  /** Tới ngày này, gồm. */
  to: string;
  shopId?: string;
}

export interface SkuProfitRow {
  variantId: string | null;
  soldQty: number;
  net: string;
  cogs: string;
  costMissing: boolean;
}

export interface SkuProfitTotals {
  total: number;
  net: string;
  cogs: string;
}

const nonCash = sql`r.kind::text in (${sql.join(
  [...NON_CASH].map((k) => sql`${k}`),
  sql`, `,
)})`;

/**
 * Bảng tạm `x`, mỗi dòng hàng giao trong kỳ một dòng (25 §10.2):
 * - `l`: dòng hàng giao trong kỳ (lọc gian hàng); `w`: tổng doanh thu, giá vốn của mọi dòng hàng đã giao của các đơn đó;
 * - `r`, `o`: thực nhận (dòng tiền còn hiệu lực, cùng `isReplaced` với lãi theo đơn) và phần giảm giá vốn của đơn;
 * - khoản cấp đơn (phí, ship, trợ giá, hoàn tiền, thuế khấu trừ, điều chỉnh) nằm trong thực nhận của đơn, chia cho
 *   dòng hàng theo tỷ lệ doanh thu (cách 25 §10.2 chia quảng cáo cho đơn theo doanh thu);
 * - giá vốn theo dòng (`unit_cost` × số lượng, dòng không có giá vốn là 0 và bật `cost_missing`); giảm giá vốn khi
 *   khách trả (`cogs_reversal` của đơn) chia theo tỷ lệ giá vốn của dòng.
 */
function lines(f: SkuProfitFilter): SQL {
  const L = ledgerPackageLines;
  return sql`with l as (
      select ${L.orderId} as order_id, ${L.variantId} as variant_id, ${L.quantity} as quantity,
        ${L.unitPrice} * ${L.quantity} as revenue, ${L.unitCost} * ${L.quantity} as cost
      from ${L}
      where ${L.occurredOn} >= ${f.from}::date and ${L.occurredOn} <= ${f.to}::date
        ${f.shopId ? sql`and ${L.shopId} = ${f.shopId}::uuid` : sql``}
    ), w as (
      select ${L.orderId} as order_id, sum(${L.unitPrice} * ${L.quantity}) as revenue,
        coalesce(sum(${L.unitCost} * ${L.quantity}), 0) as cost
      from ${L}
      where ${L.orderId} in (select order_id from l)
      group by ${L.orderId}
    ), r as (
      select ${ledgerEntries.orderId} as order_id, ${ledgerEntries.kind} as kind, ${ledgerEntries.amount} as amount,
        ${not(isReplaced())} as live
      from ${ledgerEntries}
      where ${ledgerEntries.orderId} in (select order_id from l)
    ), o as (
      select r.order_id,
        coalesce(sum(r.amount) filter (where r.live and not ${nonCash}), 0) as net,
        coalesce(sum(r.amount) filter (where r.live and r.kind = 'cogs_reversal'), 0) as reversal
      from r group by r.order_id
    ), x as (
      select l.variant_id, l.quantity,
        case when w.revenue > 0 then coalesce(o.net, 0) * l.revenue / w.revenue else 0 end as net,
        -coalesce(l.cost, 0) + case when w.cost > 0 then coalesce(o.reversal, 0) * coalesce(l.cost, 0) / w.cost else 0 end as cogs,
        l.cost is null as cost_missing
      from l join w on w.order_id = l.order_id left join o on o.order_id = l.order_id
    ), g as (
      select x.variant_id, sum(x.quantity)::int as sold_qty, round(sum(x.net)) as net, round(sum(x.cogs)) as cogs,
        bool_or(x.cost_missing) as cost_missing
      from x group by x.variant_id
    )`;
}

/**
 * Một trang SKU (thực nhận lớn trước; dòng chưa ghép SKU gộp một dòng `variantId` null, đứng cuối khi bằng nhau) kèm
 * số SKU và tổng trên toàn bộ kết quả lọc (hàm cửa sổ tính trước `limit`; trang rỗng thì đọc tổng riêng).
 */
export async function findSkuProfits(
  f: SkuProfitFilter,
  page: { limit: number; offset: number },
): Promise<{ rows: SkuProfitRow[]; totals: SkuProfitTotals }> {
  const { rows } = await getDb().execute<{
    variant_id: string | null;
    sold_qty: number;
    net: string;
    cogs: string;
    cost_missing: boolean;
    total_count: number;
    total_net: string;
    total_cogs: string;
  }>(sql`${lines(f)}
    select g.variant_id, g.sold_qty, g.net::text as net, g.cogs::text as cogs, g.cost_missing,
      (count(*) over ())::int as total_count, (sum(g.net) over ())::text as total_net, (sum(g.cogs) over ())::text as total_cogs
    from g
    order by g.net desc, g.variant_id nulls last
    limit ${page.limit} offset ${page.offset}`);
  let totals: SkuProfitTotals;
  if (rows[0]) totals = { total: rows[0].total_count, net: rows[0].total_net, cogs: rows[0].total_cogs };
  else {
    const { rows: t } = await getDb().execute<{ total: number; net: string; cogs: string }>(sql`${lines(f)}
      select count(*)::int as total, coalesce(sum(g.net), 0)::text as net, coalesce(sum(g.cogs), 0)::text as cogs from g`);
    totals = t[0]!;
  }
  return {
    rows: rows.map((r) => ({ variantId: r.variant_id, soldQty: r.sold_qty, net: r.net, cogs: r.cogs, costMissing: r.cost_missing })),
    totals,
  };
}
