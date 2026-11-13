// Lãi theo danh sách đơn (#231; Documents/21 §21.1, 25 §10.2): gộp sổ theo đơn bằng SQL, lọc, phân trang và cộng tổng
// trên toàn bộ kết quả lọc, không kéo sổ lên bộ nhớ. Cùng luật với lãi của một đơn (`orderProfit`, `profitOf`): dòng
// còn hiệu lực là dòng chưa `isReplaced`, thực nhận = dòng tiền mặt, giá vốn = `cogs` + `cogs_reversal`, nhãn Ước tính
// chỉ xét dòng tiền (`isEstimateLine`).
import { not, type SQL, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { NON_CASH } from '../domain/ledger.ts';
import { isReplaced } from './ledger.ts';
import { ledgerEntries, orderSettlements } from './schema.ts';

/** Mốc lãi tối thiểu theo ngày giao: bản mới trước, bản đầu tiên chứa ngày là bản áp (`appliedTimeline`). */
export interface MarginSegment {
  from: string;
  to: string | null;
  pct: number;
}

export interface OrderProfitFilter {
  /** Ngày giao (kiện đầu tiên giao xong, giờ Việt Nam) từ ngày này, gồm. */
  from: string;
  /** Ngày giao tới ngày này, gồm. */
  to: string;
  shopId?: string;
  costMissing?: boolean;
  belowFloor?: boolean;
  margins: readonly MarginSegment[];
}

export interface OrderProfitRow {
  orderId: string;
  shopId: string | null;
  deliveredOn: string;
  net: string;
  cogs: string;
  estimated: boolean;
  costMissing: boolean;
  belowFloor: boolean;
}

export interface OrderProfitTotals {
  total: number;
  net: string;
  cogs: string;
}

function marginCase(margins: readonly MarginSegment[]): SQL {
  if (!margins.length) return sql`null::numeric`;
  const whens = margins.map(
    (m) =>
      sql`when p.delivered_on >= ${m.from}::date${m.to ? sql` and p.delivered_on <= ${m.to}::date` : sql``} then ${String(m.pct)}::numeric`,
  );
  return sql`case ${sql.join(whens, sql` `)} else null end`;
}

const nonCash = sql`r.kind::text in (${sql.join(
  [...NON_CASH].map((k) => sql`${k}`),
  sql`, `,
)})`;

/**
 * Bảng tạm `g`, mỗi đơn có kiện đã giao trong kỳ một dòng:
 * - `o`: đơn có dòng nguồn `package`, ngày giao = ngày kiện đầu tiên giao xong (dòng nguồn `package` không mất khi bị
 *   dòng thực tế thay), lọc kỳ và gian hàng ngay đây để chỉ gộp sổ của đơn trong kỳ;
 * - `r`: dòng sổ của các đơn đó, `live` tính một lần mỗi dòng;
 * - `p`, `f`: tổng theo đơn, cờ thiếu giá vốn (#229), lãi tối thiểu áp tại ngày giao;
 * - `g`: cờ Dưới giá thấp nhất thực tế (25 §10.2, E132): đơn đã quyết toán, có giá vốn, thực nhận < giá vốn × (1 +
 *   lãi tối thiểu/100) ("Giá thấp nhất = giá vốn × (1 + lãi tối thiểu)", 25 §6.2 bước 5). Đơn còn ước tính không bật:
 *   số ước tính lấy từ chính cấu hình phí mà cờ này báo lỗi thời. Chưa có giá vốn hoặc cấu hình thì không bật.
 */
function filtered(f: OrderProfitFilter): SQL {
  const pkg = sql`${ledgerEntries.sourceType} = 'package'`;
  return sql`with o as (
      select ${ledgerEntries.orderId} as order_id, min(${ledgerEntries.occurredOn}) as delivered_on,
        (array_agg(${ledgerEntries.shopId} order by ${ledgerEntries.occurredOn}, ${ledgerEntries.createdAt}))[1] as shop_id
      from ${ledgerEntries}
      where ${pkg} and ${ledgerEntries.orderId} is not null
      group by ${ledgerEntries.orderId}
      having min(${ledgerEntries.occurredOn}) >= ${f.from}::date and min(${ledgerEntries.occurredOn}) <= ${f.to}::date
        ${f.shopId ? sql`and (array_agg(${ledgerEntries.shopId} order by ${ledgerEntries.occurredOn}, ${ledgerEntries.createdAt}))[1] = ${f.shopId}::uuid` : sql``}
    ), r as (
      select ${ledgerEntries.orderId} as order_id, ${ledgerEntries.kind} as kind, ${ledgerEntries.amount} as amount,
        ${ledgerEntries.isEstimate} as is_estimate, ${not(isReplaced())} as live
      from ${ledgerEntries}
      where ${ledgerEntries.orderId} in (select order_id from o)
    ), p as (
      select o.order_id, o.delivered_on, o.shop_id,
        coalesce(sum(r.amount) filter (where r.live and not ${nonCash}), 0) as net,
        coalesce(sum(r.amount) filter (where r.live and ${nonCash}), 0) as cogs,
        coalesce(bool_or(r.is_estimate) filter (where r.live and not ${nonCash}), false) as estimated
      from o join r on r.order_id = o.order_id
      group by o.order_id, o.delivered_on, o.shop_id
    ), f as (
      select p.*, coalesce(${orderSettlements.costMissing}, false) as cost_missing, ${marginCase(f.margins)} as min_margin_pct
      from p left join ${orderSettlements} on ${orderSettlements.orderId} = p.order_id
    ), g as (
      select f.*, coalesce(not f.estimated and f.cogs < 0 and f.net < -f.cogs * (1 + f.min_margin_pct / 100), false) as below_floor
      from f
    )`;
}

function where(f: OrderProfitFilter): SQL {
  return sql`where true
    ${f.costMissing === undefined ? sql`` : sql`and g.cost_missing = ${f.costMissing}`}
    ${f.belowFloor === undefined ? sql`` : sql`and g.below_floor = ${f.belowFloor}`}`;
}

async function totalsOnly(f: OrderProfitFilter): Promise<OrderProfitTotals> {
  const { rows } = await getDb().execute<{ total: number; net: string; cogs: string }>(sql`${filtered(f)}
    select count(*)::int as total, coalesce(sum(g.net), 0)::text as net, coalesce(sum(g.cogs), 0)::text as cogs
    from g ${where(f)}`);
  return rows[0]!;
}

/**
 * Một trang đơn (giao mới trước) kèm số đơn và tổng thực nhận, giá vốn trên toàn bộ kết quả lọc, trong một câu (hàm
 * cửa sổ tính trước `limit`). Trang rỗng (vượt số trang) thì đọc tổng riêng.
 */
export async function findOrderProfits(
  f: OrderProfitFilter,
  page: { limit: number; offset: number },
): Promise<{ rows: OrderProfitRow[]; totals: OrderProfitTotals }> {
  const { rows } = await getDb().execute<{
    order_id: string;
    shop_id: string | null;
    delivered_on: string;
    net: string;
    cogs: string;
    estimated: boolean;
    cost_missing: boolean;
    below_floor: boolean;
    total_count: number;
    total_net: string;
    total_cogs: string;
  }>(sql`${filtered(f)}
    select g.order_id, g.shop_id, g.delivered_on::text as delivered_on, g.net::text as net, g.cogs::text as cogs, g.estimated,
      g.cost_missing, g.below_floor, (count(*) over ())::int as total_count, (sum(g.net) over ())::text as total_net,
      (sum(g.cogs) over ())::text as total_cogs
    from g ${where(f)}
    order by g.delivered_on desc, g.order_id desc
    limit ${page.limit} offset ${page.offset}`);
  const first = rows[0];
  const totals = first ? { total: first.total_count, net: first.total_net, cogs: first.total_cogs } : await totalsOnly(f);
  return {
    rows: rows.map((r) => ({
      orderId: r.order_id,
      shopId: r.shop_id,
      deliveredOn: r.delivered_on,
      net: r.net,
      cogs: r.cogs,
      estimated: r.estimated,
      costMissing: r.cost_missing,
      belowFloor: r.below_floor,
    })),
    totals,
  };
}
