// Đọc báo cáo cho API (Documents/21 §21.5, #333): gom thẳng sổ tiền của finance mỗi lần gọi, không có bảng dựng sẵn.
// Mọi hàm chạy trong `withCompany` của công ty người xem.
import { getShops } from '../../../channel/index.ts';
import { getSelfApprovals } from '../../../core/index.ts';
import { getDailyLedgerFigures } from '../../../finance/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { addDays, eachDay } from '../domain/days.ts';
import { type DayRow, type ReportFigures, sourceOf, sumFigures } from '../domain/figures.ts';
import type { OrderSource } from '../domain/summary.ts';

export interface Viewer {
  companyId: string;
  /** `inventory.cost.view`: thấy giá vốn, lãi (D18). */
  canCost: boolean;
}

export interface Range {
  from: string;
  to: string;
}

export interface ShopFigures extends ReportFigures {
  source: OrderSource;
  /** Trống với hộp thư, đơn tay. Gian hàng không còn trong `channel` thì `shopName`, `platform` là `null`. */
  shop: { id: string; shopName: string | null; platform: string | null } | null;
}

const SOURCE_ORDER: Record<OrderSource, number> = { marketplace: 0, inbox: 1, manual: 2 };

/** Bộ lọc của `/daily`: `shopId` đi với sàn; `inbox` không có dòng sổ nào (sổ không tách đơn hộp thư). */
export interface DayFilter {
  source?: OrderSource | undefined;
  shopId?: string | undefined;
}

async function load(range: Range, filter: DayFilter = {}): Promise<{ rows: DayRow[]; asOf: string | null }> {
  if (filter.source === 'inbox') return { rows: [], asOf: null };
  const withShop = filter.source === 'marketplace' ? true : filter.source === 'manual' ? false : undefined;
  const rows = await getDailyLedgerFigures(range.from, range.to, { shopId: filter.shopId, withShop });
  const latest = rows.reduce<Date | null>((max, r) => (max && max >= r.lastAt ? max : r.lastAt), null);
  return { rows, asOf: latest?.toISOString() ?? null };
}

export async function overview(viewer: Viewer, range: Range) {
  return withCompany(viewer.companyId, async () => {
    const { rows, asOf } = await load(range);
    return { ...range, asOf, ...sumFigures(rows, viewer.canCost) };
  });
}

export async function byShop(viewer: Viewer, range: Range) {
  return withCompany(viewer.companyId, async () => {
    const { rows, asOf } = await load(range);
    const groups = Map.groupBy(rows, (r) => r.shopId ?? '');
    const shopIds = [...new Set(rows.flatMap((r) => (r.shopId ? [r.shopId] : [])))];
    const shops = await getShops(shopIds);
    const shopOf = (id: string | null): ShopFigures['shop'] =>
      id ? (shops.get(id) ?? { id, shopName: null, platform: null }) : null;
    const items: ShopFigures[] = [...groups.values()].map((g) => ({
      source: sourceOf(g[0]!.shopId),
      shop: shopOf(g[0]!.shopId),
      ...sumFigures(g, viewer.canCost),
    }));
    items.sort(
      (a, b) =>
        SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] || (a.shop?.shopName ?? '').localeCompare(b.shop?.shopName ?? ''),
    );
    return { ...range, asOf, items, total: sumFigures(rows, viewer.canCost) };
  });
}

export async function daily(viewer: Viewer, range: Range, filter: DayFilter) {
  return withCompany(viewer.companyId, async () => {
    const { rows, asOf } = await load(range, filter);
    const byDay = Map.groupBy(rows, (r) => r.day);
    const items = eachDay(range.from, range.to).map((day) => ({ day, ...sumFigures(byDay.get(day) ?? [], viewer.canCost) }));
    return { ...range, asOf, items };
  });
}

const vnStart = (day: string) => new Date(`${day}T00:00:00+07:00`);

/** Các lần tự duyệt trong khoảng ngày giờ VN, mới trước (Documents/25 mục 11: "hiện trên báo cáo CEO", #246). */
export async function selfApprovals(viewer: Viewer, range: Range, page: { page: number; pageSize: number }) {
  return withCompany(viewer.companyId, async () => {
    const { items, total } = await getSelfApprovals(
      { from: vnStart(range.from), to: vnStart(addDays(range.to, 1)) },
      { limit: page.pageSize, offset: (page.page - 1) * page.pageSize },
    );
    return { ...range, items: items.map((i) => ({ ...i, at: i.at.toISOString() })), total, ...page };
  });
}
