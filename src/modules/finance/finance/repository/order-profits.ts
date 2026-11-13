// Lãi theo danh sách đơn (#231; Documents/21 §21.1, 25 §10.2): gộp sổ theo đơn bằng SQL, lọc, phân trang và cộng tổng
// trên toàn bộ kết quả lọc, không kéo sổ lên bộ nhớ. Cùng cách tính với `profitOf` (một đơn): dòng còn hiệu lực là
// dòng chưa bị thay (`isReplaced`), thực nhận = dòng tiền mặt, giá vốn = `cogs` + `cogs_reversal`.
import { inArray, not, type SQL, sql } from 'drizzle-orm';
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

function marginCase(margins: readonly MarginSegment[]): SQL {
  if (!margins.length) return sql`null::numeric`;
  const whens = margins.map(
    (m) =>
      sql`when p.delivered_on >= ${m.from}::date${m.to ? sql` and p.delivered_on <= ${m.to}::date` : sql``} then ${String(m.pct)}::numeric`,
  );
  return sql`case ${sql.join(whens, sql` `)} else null end`;
}

/**
 * Bảng tạm `g`: mỗi đơn có kiện đã giao (có dòng nguồn `package`) một dòng. Ngày giao là ngày kiện đầu tiên giao xong
 * (dòng nguồn `package` không bao giờ mất: kể cả khi đã bị dòng thực tế thay vẫn còn ngày). Cờ Dưới giá thấp nhất cùng
 * điều kiện `isBelowFloor` (domain/order-profit.ts).
 */
function filtered(f: OrderProfitFilter): SQL {
  const live = not(isReplaced());
  const nonCash = inArray(ledgerEntries.kind, [...NON_CASH]);
  const pkg = sql`${ledgerEntries.sourceType} = 'package'`;
  return sql`with p as (
      select ${ledgerEntries.orderId} as order_id,
        min(${ledgerEntries.occurredOn}) filter (where ${pkg}) as delivered_on,
        (array_agg(${ledgerEntries.shopId}) filter (where ${pkg}))[1] as shop_id,
        coalesce(sum(${ledgerEntries.amount}) filter (where ${live} and not ${nonCash}), 0) as net,
        coalesce(sum(${ledgerEntries.amount}) filter (where ${live} and ${nonCash}), 0) as cogs,
        coalesce(bool_or(${ledgerEntries.isEstimate}) filter (where ${live} and not ${nonCash}), false) as estimated
      from ${ledgerEntries}
      where ${ledgerEntries.orderId} is not null
      group by ${ledgerEntries.orderId}
      having bool_or(${pkg})
    ), f as (
      select p.*, coalesce(${orderSettlements.costMissing}, false) as cost_missing, ${marginCase(f.margins)} as min_margin_pct
      from p left join ${orderSettlements} on ${orderSettlements.orderId} = p.order_id
      where p.delivered_on >= ${f.from}::date and p.delivered_on <= ${f.to}::date
        ${f.shopId ? sql`and p.shop_id = ${f.shopId}::uuid` : sql``}
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

/** Một trang đơn, giao mới trước. */
export async function findOrderProfits(f: OrderProfitFilter, page: { limit: number; offset: number }): Promise<OrderProfitRow[]> {
  const { rows } = await getDb().execute<{
    order_id: string;
    shop_id: string | null;
    delivered_on: string;
    net: string;
    cogs: string;
    estimated: boolean;
    cost_missing: boolean;
    below_floor: boolean;
  }>(sql`${filtered(f)}
    select g.order_id, g.shop_id, g.delivered_on::text as delivered_on, g.net::text as net, g.cogs::text as cogs, g.estimated,
      g.cost_missing, g.below_floor
    from g ${where(f)}
    order by g.delivered_on desc, g.order_id desc
    limit ${page.limit} offset ${page.offset}`);
  return rows.map((r) => ({
    orderId: r.order_id,
    shopId: r.shop_id,
    deliveredOn: r.delivered_on,
    net: r.net,
    cogs: r.cogs,
    estimated: r.estimated,
    costMissing: r.cost_missing,
    belowFloor: r.below_floor,
  }));
}

/** Số đơn và tổng thực nhận, giá vốn trên toàn bộ kết quả lọc (không chỉ trang). */
export async function orderProfitTotals(f: OrderProfitFilter): Promise<{ total: number; net: string; cogs: string }> {
  const { rows } = await getDb().execute<{ total: number; net: string; cogs: string }>(sql`${filtered(f)}
    select count(*)::int as total, coalesce(sum(g.net), 0)::text as net, coalesce(sum(g.cogs), 0)::text as cogs
    from g ${where(f)}`);
  return rows[0]!;
}
