// Đọc báo cáo cho API (Documents/21 §12.7). Mọi hàm chạy trong `withCompany` của công ty người xem.
import { getShops } from '../../../channel/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { eachDay } from '../domain/days.ts';
import { type ReportFigures, sumFigures } from '../domain/figures.ts';
import type { OrderSource } from '../domain/summary.ts';
import { readDays } from '../repository/summary.ts';

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

async function load(range: Range, filter?: Parameters<typeof readDays>[2]) {
  const rows = await readDays(range.from, range.to, filter);
  const latest = rows.reduce<Date | null>((max, r) => (max && max >= r.updatedAt ? max : r.updatedAt), null);
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
    const groups = Map.groupBy(rows, (r) => `${r.source}|${r.shopId ?? ''}`);
    const shopIds = [...new Set(rows.flatMap((r) => (r.shopId ? [r.shopId] : [])))];
    const shops = await getShops(shopIds);
    const shopOf = (id: string | null): ShopFigures['shop'] =>
      id ? (shops.get(id) ?? { id, shopName: null, platform: null }) : null;
    const items: ShopFigures[] = [...groups.values()].map((g) => ({
      source: g[0]!.source,
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

export async function daily(viewer: Viewer, range: Range, filter: { source?: OrderSource; shopId?: string }) {
  return withCompany(viewer.companyId, async () => {
    const { rows, asOf } = await load(range, filter);
    const byDay = Map.groupBy(rows, (r) => r.day);
    const items = eachDay(range.from, range.to).map((day) => ({ day, ...sumFigures(byDay.get(day) ?? [], viewer.canCost) }));
    return { ...range, asOf, items };
  });
}
