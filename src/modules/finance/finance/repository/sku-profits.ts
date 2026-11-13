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
  /** Số đơn bị loại vì có kiện đã ghi sổ mà không có dòng hàng (kiện giao trước khi lưu dòng hàng). */
  excludedOrders: number;
}

const kindIn = (kinds: Iterable<string>) =>
  sql.join(
    [...kinds].map((k) => sql`${k}`),
    sql`, `,
  );

/**
 * Bảng tạm `x`, mỗi dòng hàng giao trong kỳ một dòng (25 §10.2):
 * - `p`: đơn có dòng hàng giao trong kỳ (lọc gian hàng); `bad`: đơn trong đó có dòng sổ nguồn `package` mà kiện không
 *   có dòng hàng (giao trước khi lưu dòng hàng): loại cả đơn, đếm vào `excludedOrders`;
 * - `a`: mọi dòng hàng đã giao của các đơn còn lại, `in_period` đánh dấu dòng trong kỳ; `o`: thực nhận của đơn (dòng
 *   tiền chưa `isReplaced`, như lãi theo đơn) và giá vốn của đơn (`cogs` + `cogs_reversal`);
 * - thực nhận chia cho dòng hàng theo tỷ lệ doanh thu, giá vốn theo tỷ lệ giá vốn của dòng (dòng thiếu giá vốn nhận 0,
 *   bật `cost_missing`). Chia trên mọi dòng của đơn rồi mới lọc kỳ; làm tròn tới đồng bằng phần dư lớn nhất trong từng
 *   đơn, nên tổng các dòng của một đơn đúng bằng số của đơn ở lãi theo đơn;
 * - đơn có doanh thu dòng hàng bằng 0 (hoặc giá vốn dòng hàng bằng 0 mà sổ có giá vốn): phần không chia được gom vào
 *   dòng `variant_id` null, không mất.
 */
function lines(f: SkuProfitFilter): SQL {
  const L = ledgerPackageLines;
  const E = ledgerEntries;
  const inPeriod = sql`${L.occurredOn} >= ${f.from}::date and ${L.occurredOn} <= ${f.to}::date ${f.shopId ? sql`and ${L.shopId} = ${f.shopId}::uuid` : sql``}`;
  return sql`with p as (
      select distinct ${L.orderId} as order_id from ${L} where ${inPeriod}
    ), bad as (
      select distinct ${E.orderId} as order_id from ${E}
      where ${E.orderId} in (select order_id from p) and ${E.sourceType} = 'package'
        and not exists (select 1 from ${L} pl where pl.package_id = ${E.sourceId})
    ), a as (
      select ${L.id} as id, ${L.orderId} as order_id, ${L.variantId} as variant_id, ${L.quantity} as quantity,
        ${L.unitPrice} * ${L.quantity} as revenue, ${L.unitCost} * ${L.quantity} as cost, (${inPeriod}) as in_period
      from ${L}
      where ${L.orderId} in (select order_id from p) and ${L.orderId} not in (select order_id from bad)
    ), r as (
      select ${E.orderId} as order_id, ${E.kind}::text as kind, ${E.amount} as amount, ${not(isReplaced())} as live
      from ${E} where ${E.orderId} in (select order_id from a)
    ), rs as (
      select r.order_id,
        coalesce(sum(r.amount) filter (where r.live and r.kind not in (${kindIn(NON_CASH)})), 0) as net,
        coalesce(sum(r.amount) filter (where r.kind in (${kindIn(NON_CASH)})), 0) as cogs
      from r group by r.order_id
    ), o as (
      select a.order_id, sum(a.revenue) as revenue, coalesce(sum(a.cost), 0) as cost, bool_or(a.in_period) as in_period,
        coalesce(max(rs.net), 0) as net, coalesce(max(rs.cogs), 0) as cogs
      from a left join rs on rs.order_id = a.order_id group by a.order_id
    ), s as (
      select a.id, a.order_id, a.variant_id, a.quantity, a.in_period, a.cost is null as cost_missing,
        o.revenue > 0 as has_revenue, o.cost > 0 as has_cost, o.net as order_net, o.cogs as order_cogs,
        case when o.revenue > 0 then o.net * a.revenue / o.revenue else 0 end as net_share,
        case when o.cost > 0 then o.cogs * coalesce(a.cost, 0) / o.cost else 0 end as cogs_share
      from a join o on o.order_id = a.order_id
    ), t as (
      select s.*,
        row_number() over (partition by s.order_id order by s.net_share - floor(s.net_share) desc, s.id) as net_rank,
        case when s.has_revenue then s.order_net - sum(floor(s.net_share)) over (partition by s.order_id) else 0 end as net_extra,
        row_number() over (partition by s.order_id order by s.cogs_share - floor(s.cogs_share) desc, s.id) as cogs_rank,
        case when s.has_cost then s.order_cogs - sum(floor(s.cogs_share)) over (partition by s.order_id) else 0 end as cogs_extra
      from s
    ), x as (
      select t.variant_id, t.quantity, t.cost_missing,
        floor(t.net_share) + least(1, greatest(0, t.net_extra - (t.net_rank - 1))) as net,
        floor(t.cogs_share) + least(1, greatest(0, t.cogs_extra - (t.cogs_rank - 1))) as cogs
      from t where t.in_period
      union all
      select null::uuid, 0, false, case when o.revenue > 0 then 0 else o.net end, case when o.cost > 0 then 0 else o.cogs end
      from o where o.in_period and ((o.revenue <= 0 and o.net <> 0) or (o.cost <= 0 and o.cogs <> 0))
    ), g as (
      select x.variant_id, sum(x.quantity)::int as sold_qty, sum(x.net) as net, sum(x.cogs) as cogs,
        bool_or(x.cost_missing) as cost_missing
      from x group by x.variant_id
    )`;
}

/**
 * Một trang SKU (thực nhận lớn trước; dòng chưa ghép SKU gộp một dòng `variantId` null, đứng cuối khi bằng nhau) kèm
 * số SKU, tổng trên toàn bộ kết quả lọc và số đơn bị loại vì thiếu dòng hàng.
 */
export async function findSkuProfits(
  f: SkuProfitFilter,
  page: { limit: number; offset: number },
): Promise<{ rows: SkuProfitRow[]; totals: SkuProfitTotals }> {
  const { rows } = await getDb().execute<{ variant_id: string | null; sold_qty: number; net: string; cogs: string; cost_missing: boolean }>(sql`${lines(f)}
    select g.variant_id, g.sold_qty, g.net::text as net, g.cogs::text as cogs, g.cost_missing
    from g
    order by g.net desc, g.variant_id nulls last
    limit ${page.limit} offset ${page.offset}`);
  const { rows: t } = await getDb().execute<SkuProfitTotals & Record<string, unknown>>(sql`${lines(f)}
    select (select count(*) from g)::int as total, (select coalesce(sum(g.net), 0) from g)::text as net,
      (select coalesce(sum(g.cogs), 0) from g)::text as cogs, (select count(*) from bad)::int as "excludedOrders"`);
  return {
    rows: rows.map((r) => ({ variantId: r.variant_id, soldQty: r.sold_qty, net: r.net, cogs: r.cogs, costMissing: r.cost_missing })),
    totals: t[0]!,
  };
}
