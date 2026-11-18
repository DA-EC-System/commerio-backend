// Dựng đơn sàn bị chia lại kiện cho test #238 PR 3 (`resplit-sync.test.ts`, `resplit-open.test.ts`).
import { randomUUID } from 'node:crypto';
import type { PlatformOrder } from '#src/modules/order/index.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { ingest, remote, withStatus, type LineStatus } from './platform-fixtures.ts';

export const tag = () => randomUUID().slice(0, 8);

/** Công ty, một SKU có `stock` đơn vị (0: chưa nhập); `token` của CEO. */
export async function setup(stock: number) {
  const company = await createCompany();
  const { variantId, sku } = await createVariant(company.companyId);
  if (stock > 0) await receive(company.companyId, variantId, stock, 100000);
  return { companyId: company.companyId, token: company.ceo.token, variantId, sku };
}

/** Mã kiện sàn của từng món (`codes[i]` cho món thứ i). */
export const relabeled = (o: PlatformOrder, codes: readonly (string | null)[]): PlatformOrder => ({
  ...o,
  lines: o.lines.map((l, i) => ({ ...l, packageCode: codes[i] ?? null })),
});
export const unpacked = (o: PlatformOrder) => relabeled(o, o.lines.map(() => null));

/** Trạng thái riêng từng món (`statuses[i]` cho món i). */
export const itemStatuses = (o: PlatformOrder, statuses: readonly LineStatus[]): PlatformOrder => ({
  ...o,
  lines: o.lines.map((l, i) => ({ ...l, status: statuses[i]!, rawStatus: statuses[i]! })),
});

export const external = (o: PlatformOrder, i: number) => o.lines[i]!.externalLineId;

export interface Row {
  id: string;
  code: string;
  status: string;
  platformCode: string | null;
  replaces: string | null;
  version: number;
  needsAttention: boolean;
  flagNote: string | null;
  needsOpen: boolean;
  openPurpose: string | null;
  items: string[];
}

/** Kiện của đơn theo mã app, kèm món (`external_line_id`) của mọi dòng. */
export async function packagesOf(orderId: string): Promise<Row[]> {
  const { rows } = await testPool().query<Row>(
    `select p.id, p.code, p.status, p.platform_package_code as "platformCode", p.replaces_package_id as "replaces", p.version,
            p.needs_attention as "needsAttention", p.flag_note as "flagNote", p.needs_open as "needsOpen", p.open_purpose as "openPurpose",
            coalesce(array_agg(ol.external_line_id order by ol.external_line_id) filter (where ol.id is not null), '{}') as items
       from "order".packages p
       left join "order".package_lines pl on pl.package_id = p.id
       left join "order".order_lines ol on ol.id = pl.order_line_id
      where p.order_id = $1 group by p.id order by p.code`,
    [orderId],
  );
  return rows;
}

export async function orderFlag(orderId: string) {
  const { rows } = await testPool().query<{ needs_attention: boolean; attention_note: string | null }>(
    'select needs_attention, attention_note from "order".orders where id = $1',
    [orderId],
  );
  return rows[0]!;
}

/** Số dòng lịch sử trạng thái của mọi kiện của đơn. */
export async function historyCount(orderId: string) {
  const { rows } = await testPool().query<{ n: number }>(
    `select count(*)::int as n from core.state_transitions where entity_type = 'packages'
       and entity_id in (select id from "order".packages where order_id = $1)`,
    [orderId],
  );
  return rows[0]!.n;
}

/** Dòng của kiện theo món: số đang giữ, số chờ bỏ. */
export async function lineRows(packageId: string) {
  const { rows } = await testPool().query<{ item: string; reserved: number; drop: number }>(
    `select ol.external_line_id as item, pl.reserved_qty as reserved, pl.pending_drop_qty as drop
       from "order".package_lines pl join "order".order_lines ol on ol.id = pl.order_line_id
      where pl.package_id = $1 order by ol.external_line_id`,
    [packageId],
  );
  return rows;
}

/**
 * AC15: kiện `packed` 2 món chia thành 2 mã mới. Sàn chia lại kiện đã đóng thì món về chờ đóng gói (`pending`): kiện mới
 * nằm ở `backordered` chờ kho mở kiện cũ (sàn báo `packed` thì vòng áp trạng thái nhảy cóc như kiện đã có, D23).
 */
export async function packedSplit(stock = 10) {
  const v = await setup(stock);
  const o = remote(v, { lines: 2, status: 'packed' });
  const { orderId, packageId } = await ingest(v.companyId, o);
  const next = withStatus(relabeled(o, [`FP-A-${tag()}`, `FP-B-${tag()}`]), 'pending');
  await ingest(v.companyId, next);
  const rows = await packagesOf(orderId);
  const fresh = (i: number) => rows.find((r) => r.replaces === packageId && r.items.includes(external(o, i)))!;
  return { v, o, orderId, packageId, next, a: fresh(0), b: fresh(1) };
}
