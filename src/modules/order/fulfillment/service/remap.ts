// Áp ghép SKU lên dòng kiện đã có (spec 237 §5.5): một chỗ thi hành mọi việc trên kiện và tồn khi một SKU sàn vừa
// được ghép. Sales (`applySkuMapping`) gọi trong giao dịch ghép của channel, sau khi đã khoá dòng đơn. Luật thuần ở
// `domain/remap.ts`.
import { sql } from 'drizzle-orm';
import { publishEvent, recordTransition } from '../../../core/index.ts';
import { requireCompanyId } from '../../../../shared/db/client.ts';
import { type MappedSku, planRemap, type RemapOutcome, type RemapStock } from '../domain/remap.ts';
import { takeAllocationLock } from '../repository/allocation.ts';
import {
  type HandoverPackage,
  lockPackagesOfOrderLines,
  markLinesReserved,
  type PackageLineRow,
  setLineSku,
  setReserved,
  updatePackage,
} from '../repository/packages.ts';
import { movePackage, requestAllocation } from './allocation.ts';
import { reportDelivered } from './delivery.ts';
import { settleHandover, shipLateMappedLines } from './handover-stock.ts';
import { stockPort } from './stock-port.ts';

type LockedPackage = HandoverPackage & { lines: PackageLineRow[] };

export interface RemapOptions {
  /** Người làm bước có hiệu lực (người ghép, hoặc CEO duyệt). */
  actorId: string;
  /** Gian hàng không chờ kiểm kê đầu kỳ: được giữ, trừ tồn. */
  holdStock: boolean;
  /** Mốc kéo đơn của gian hàng: kiện rời kho trước mốc không trừ (P3, D11). */
  orderCutoffAt: Date | null;
  /** Lý do ghi lên lịch sử `remap` của kiện, vd "Ghép SKU <SKU người bán>". */
  reason: string;
}

// Kết quả của dòng đơn nằm ở nhiều dòng kiện: dòng "nặng" nhất thắng.
const WEIGHT: Record<RemapOutcome, number> = { applied: 0, kept: 1, needs_unload: 2 };

const variantIdsOf = (lines: readonly { variantId: string | null }[]) =>
  [...new Set(lines.flatMap((l) => (l.variantId ? [l.variantId] : [])))].sort();

/**
 * Áp ghép cho các dòng đơn (spec 237 §5.5). Thứ tự khoá: advisory phân hàng → kiện chứa dòng (id tăng) → dòng tồn (cổng
 * tồn). Mỗi kiện có dòng ghi: một dòng lịch sử `remap` (`from = to`), `version` tăng, rồi việc trên tồn theo `planRemap`,
 * rồi báo giao xong nếu kiện đã `delivered`. Chạy trong `withCompany` và giao dịch của bên gọi; lỗi nào cũng ném để cả
 * giao dịch ghép rollback.
 *
 * Trả kết quả theo dòng đơn. Dòng đơn không có dòng kiện nào vắng trong `Map` (bên gọi coi là `applied`); dòng đơn có
 * nhiều dòng kiện: `applied` khi mọi dòng kiện `applied`, không thì kết quả nặng nhất (`needs_unload` > `kept`).
 */
export async function remapPackageLines(
  changes: readonly { orderLineId: string; to: MappedSku }[],
  opts: RemapOptions,
): Promise<Map<string, RemapOutcome>> {
  const result = new Map<string, RemapOutcome>();
  if (!changes.length) return result;
  await takeAllocationLock(requireCompanyId('remapPackageLines'));
  const byLine = new Map(changes.map((c) => [c.orderLineId, c.to]));
  for (const pkg of await lockPackagesOfOrderLines([...byLine.keys()])) {
    const plan = planRemap(pkg, byLine, opts);
    for (const l of pkg.lines) {
      const outcome = plan.outcomes.get(l.id);
      if (!outcome) continue;
      const prev = result.get(l.orderLineId);
      if (!prev || WEIGHT[outcome] > WEIGHT[prev]) result.set(l.orderLineId, outcome);
    }
    if (!plan.writes.length) continue;

    await writeLines(pkg, plan.writes);
    // Lịch sử `remap` trước `hold`/`reclaim` (P5): hai bước đó tự ghi lịch sử với người làm trống như lượt phân hàng.
    await updatePackage(pkg.id, {});
    await recordTransition({ entityType: 'packages', entityId: pkg.id, from: pkg.status, to: pkg.status, action: 'remap', actorId: opts.actorId, reason: opts.reason });
    await applyStock(pkg, plan.stock, opts);
    if (plan.reportDelivered) await reportDelivered(pkg.id);
  }
  return result;
}

/** Ghi ghép mới lên dòng kiện, gom theo đích; cập nhật `pkg.lines` tại chỗ cho bước tồn. */
async function writeLines(pkg: LockedPackage, writes: readonly { lineId: string; to: MappedSku }[]) {
  const groups = new Map<string, { to: MappedSku; ids: string[] }>();
  for (const w of writes) {
    const key = w.to.kind === 'variant' ? w.to.variantId : w.to.kind;
    const group = groups.get(key) ?? { to: w.to, ids: [] };
    group.ids.push(w.lineId);
    groups.set(key, group);
  }
  for (const { to, ids } of groups.values()) await setLineSku(ids, to);
  const written = new Map(writes.map((w) => [w.lineId, w.to]));
  for (const l of pkg.lines) {
    const to = written.get(l.id);
    if (!to) continue;
    l.variantId = to.kind === 'variant' ? to.variantId : null;
    l.stockUntracked = to.kind === 'untracked';
  }
}

/** Nhả mọi dòng đang giữ của kiện `reserved`, kiện về `backordered` (mũi tên `reclaim`). */
async function reclaim(pkg: LockedPackage) {
  const held = pkg.lines.filter((l) => l.variantId && l.reservedQty > 0);
  if (held.length) await stockPort().release(pkg.id, held.map((l) => ({ variantId: l.variantId!, quantity: l.reservedQty })));
  await setReserved(pkg.id, false);
  for (const l of pkg.lines) l.reservedQty = 0;
  await movePackage(pkg, 'reserved', 'reclaim', {});
  pkg.status = 'backordered';
}

async function applyStock(pkg: LockedPackage, stock: RemapStock, opts: RemapOptions) {
  switch (stock.kind) {
    case 'none':
      return;
    case 'hold':
      // Không còn gì để giữ (D10): không gọi cổng tồn.
      await movePackage(pkg, 'backordered', 'hold', { reservedAt: sql`now()` });
      pkg.status = 'reserved';
      return;
    case 'allocate':
      await requestAllocation(stock.variantIds);
      return;
    case 'reclaim':
      // Gian hàng chờ kiểm kê: không xếp lượt, lượt phiếu đầu kỳ `{ all: true }` sẽ giữ.
      await reclaim(pkg);
      return;
    case 'reserve_new': {
      const fresh = pkg.lines.filter((l) => stock.lineIds.includes(l.id));
      const { reserved } = await stockPort().reserve(pkg.id, fresh.map((l) => ({ variantId: l.variantId!, quantity: l.quantity })));
      if (reserved) {
        await markLinesReserved(stock.lineIds);
        for (const l of fresh) l.reservedQty = l.quantity;
        // Giữ ngoài lượt phân hàng: inventory `reserve` không phát `stock_changed`, channel chỉ đẩy tồn theo
        // `allocation_done` (như kiện mới lập, spec 199b D4).
        await publishEvent({
          type: 'fulfillment.allocation_done',
          aggregateId: requireCompanyId('remapPackageLines'),
          payload: { variantIds: variantIdsOf(fresh) },
        });
      } else if (!stock.sealed) {
        // Kiện `reserved` không được giữ thiếu (Review Focus 3): nhả cả kiện, xếp lượt cho mọi biến thể của kiện.
        await reclaim(pkg);
        await requestAllocation(variantIdsOf(pkg.lines));
      } else {
        // Kiện đã đóng giữ nguyên; lõi bàn giao thử giữ lại rồi bàn giao bắt buộc nếu vẫn thiếu.
        await requestAllocation(variantIdsOf(fresh));
      }
      return;
    }
    case 'ship':
      await shipLateMappedLines(pkg.id);
      return;
    case 'store_only':
      await settleHandover(pkg, { actorId: opts.actorId, mode: 'store_only' });
      return;
  }
}
