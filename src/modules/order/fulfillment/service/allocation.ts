// Một lượt phân hàng cho kiện (Documents/25 §7.4, 21 §11.1, spec 199b §5.3): lấy lại phần giữ khi tồn thực xuống dưới
// đang giữ, rồi giữ kiện chưa giữ theo thứ tự, rồi phát `fulfillment.allocation_done`. Chạy trong giao dịch của bên gọi,
// dưới khoá advisory theo công ty nên hai lượt không chen nhau. Gọi lại đọc lại trạng thái từ đầu, không giữ hay lấy thêm.
import { assertTransition, publishEvent, recordTransition } from '../../../core/index.ts';
import { requireCompanyId } from '../../../../shared/db/client.ts';
import { allocationQueue, planAllocation, planReclaim } from '../domain/allocation.ts';
import { packageMachine, type PackageStatus } from '../domain/package.ts';
import { lockAllocationCandidates, lockReclaimCandidates, takeAllocationLock, variantsInPlay } from '../repository/allocation.ts';
import { markLinesReserved, setReserved, updatePackage } from '../repository/packages.ts';
import { type FulfillmentContext, stockHoldLookupOf } from './packages.ts';
import { stockPort } from './stock-port.ts';

export type AllocationScope = { variantIds: readonly string[] } | { all: true };
export interface AllocationCause {
  type: 'stocktake';
  documentId: string;
}
export type AllocationContext = Pick<FulfillmentContext, 'stockHoldOf'>;

/** Kiện đã đóng không giữ được sau phiếu kiểm kê đầu kỳ (spec 199b D5; chưa có khung việc #209). */
export const DISMANTLE_NOTE = 'Dỡ kiện về kệ: số đếm thấp hơn hàng trong kiện';

const unique = <T>(xs: Iterable<T>) => [...new Set(xs)];

async function move(p: { id: string; orderId: string }, from: PackageStatus, action: 'hold' | 'reclaim', extra: { reservedAt?: Date }) {
  const { to } = assertTransition(packageMachine, from, action, { actor: null });
  await updatePackage(p.id, { status: to, ...extra });
  await recordTransition({ entityType: 'packages', entityId: p.id, from, to, action, actorId: null });
  await publishEvent({ type: 'fulfillment.package_status_changed', aggregateId: p.orderId, payload: { packageId: p.id, orderId: p.orderId, from, to } });
}

/**
 * `opening`: lượt sau phiếu kiểm kê đầu kỳ (spec 199b §5.5): không lọc gian hàng chờ kiểm kê, kiện đã đóng không giữ
 * được thì bật Cần xử lý. `cause` gắn vào `allocation_done`.
 */
export async function runAllocation(
  ctx: AllocationContext,
  scope: AllocationScope,
  opts: { opening?: boolean; cause?: AllocationCause } = {},
): Promise<{ held: string[]; reclaimed: string[]; variantIds: string[] }> {
  const companyId = requireCompanyId('runAllocation');
  await takeAllocationLock(companyId);
  const port = stockPort();
  const trigger = 'all' in scope ? [] : unique(scope.variantIds);
  let skus = 'all' in scope ? await variantsInPlay() : trigger;
  const touched = new Set<string>();

  // Lấy lại phần giữ: SKU có đang giữ lớn hơn tồn thực.
  const reclaimed: string[] = [];
  if (skus.length) {
    const stock = await port.stockOf(skus);
    const deficits = new Map([...stock].filter(([, s]) => s.reserved > s.onHand).map(([v, s]) => [v, s.reserved - s.onHand]));
    for (const c of deficits.size ? planReclaim(deficits, await lockReclaimCandidates([...deficits.keys()])) : []) {
      await port.release(c.id, c.lines);
      await setReserved(c.id, false);
      await move(c, 'reserved', 'reclaim', {});
      reclaimed.push(c.id);
      for (const l of c.lines) touched.add(l.variantId);
    }
    skus = unique([...skus, ...touched]);
  }

  // Giữ hàng cho kiện chưa giữ, theo thứ tự.
  const held: string[] = [];
  let candidates = (await lockAllocationCandidates(skus)).filter((c) => !reclaimed.includes(c.id));
  if (!opts.opening) {
    const shopIds = unique(candidates.flatMap((c) => (c.shopId ? [c.shopId] : [])));
    const waiting = shopIds.length ? await stockHoldLookupOf(ctx)(shopIds) : new Set<string>();
    candidates = candidates.filter((c) => !c.shopId || !waiting.has(c.shopId));
  }
  if (candidates.length) {
    const stock = await port.stockOf(unique(candidates.flatMap((c) => c.lines.map((l) => l.variantId))));
    const available = new Map([...stock].map(([v, s]) => [v, s.available]));
    for (const c of planAllocation(allocationQueue(candidates), available)) {
      // Giao dịch khác có thể vừa lấy mất hàng: `reserve` là kết quả cuối, không đủ thì bỏ qua kiện này.
      if (!(await port.reserve(c.id, c.lines)).reserved) continue;
      await markLinesReserved(c.lineIds);
      if (c.status === 'backordered') await move(c, 'backordered', 'hold', { reservedAt: new Date() });
      else await updatePackage(c.id, { reservedAt: new Date() });
      held.push(c.id);
      for (const l of c.lines) touched.add(l.variantId);
    }
    if (opts.opening) {
      for (const c of candidates) {
        if (c.status === 'backordered' || held.includes(c.id) || c.needsAttention) continue;
        await updatePackage(c.id, { needsAttention: true, flagNote: DISMANTLE_NOTE });
      }
    }
  }

  const variantIds = unique([...trigger, ...touched]).sort();
  await publishEvent({
    type: 'fulfillment.allocation_done',
    aggregateId: companyId,
    payload: { variantIds, ...(opts.cause && { cause: opts.cause }) },
  });
  return { held, reclaimed, variantIds };
}
