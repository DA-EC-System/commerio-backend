// Một lượt phân hàng cho kiện (Documents/25 §7.4, 21 §11.1, spec 199b §5.3): lấy lại phần giữ khi tồn thực xuống dưới
// đang giữ, rồi giữ kiện chưa giữ theo thứ tự, rồi phát `fulfillment.allocation_done`. Chạy trong giao dịch của bên gọi,
// dưới khoá advisory theo công ty nên hai lượt không chen nhau. Gọi lại đọc lại trạng thái từ đầu, không giữ hay lấy thêm.
import { z } from 'zod';
import { assertTransition, defineQueue, JobDataSchema, publishEvent, recordTransition, sendJob } from '../../../core/index.ts';
import { sql } from 'drizzle-orm';
import { requireCompanyId, withCompany } from '../../../../shared/db/client.ts';
import { allocationQueue, planAllocation, planReclaim } from '../domain/allocation.ts';
import { packageMachine, type PackageStatus } from '../domain/package.ts';
import { allocationShops, lockAllocationCandidates, lockReclaimCandidates, takeAllocationLock, variantsInPlay } from '../repository/allocation.ts';
import { markLinesReserved, setReserved, updatePackage } from '../repository/packages.ts';
import { settleDeferredHandovers } from './handover-stock.ts';
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

async function move(p: { id: string; orderId: string }, from: PackageStatus, action: 'hold' | 'reclaim', extra: Parameters<typeof updatePackage>[1]) {
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
    const deficitsOf = (stock: Map<string, { onHand: number; reserved: number }>) =>
      new Map([...stock].filter(([, s]) => s.reserved > s.onHand).map(([v, s]) => [v, s.reserved - s.onHand]));
    const suspected = deficitsOf(await port.stockOf(skus));
    const locked = suspected.size ? await lockReclaimCandidates([...suspected.keys()]) : [];
    // Đọc lại sau khi khoá: hàng về hay kiện huỷ trong lúc chờ khoá làm phần thiếu nhỏ đi.
    const deficits = locked.length ? deficitsOf(await port.stockOf([...suspected.keys()])) : new Map<string, number>();
    for (const c of deficits.size ? planReclaim(deficits, locked) : []) {
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
  // Lượt thường bỏ gian hàng chờ kiểm kê trước khi khoá, để không giữ khoá kiện mà lần quét của gian hàng đó cần.
  let waiting: string[] = [];
  if (!opts.opening) {
    const shopIds = await allocationShops(skus);
    waiting = shopIds.length ? [...(await stockHoldLookupOf(ctx)(shopIds))] : [];
  }
  const candidates = (await lockAllocationCandidates(skus, waiting)).filter((c) => !reclaimed.includes(c.id));
  if (candidates.length) {
    const stock = await port.stockOf(unique(candidates.flatMap((c) => c.lines.map((l) => l.variantId))));
    const available = new Map([...stock].map(([v, s]) => [v, s.available]));
    for (const c of planAllocation(allocationQueue(candidates), available)) {
      // Giao dịch khác có thể vừa lấy mất hàng: `reserve` là kết quả cuối, không đủ thì bỏ qua kiện này.
      if (!(await port.reserve(c.id, c.lines)).reserved) continue;
      await markLinesReserved(c.lineIds);
      // Giữ được thì cờ "Dỡ kiện về kệ" của phiếu đầu kỳ hết đúng; giờ DB cho `reserved_at` (một đồng hồ).
      const clear = c.needsAttention && c.flagNote === DISMANTLE_NOTE ? { needsAttention: false, flagNote: null } : {};
      const reservedAt = sql`now()`;
      if (c.status === 'backordered') await move(c, 'backordered', 'hold', { reservedAt, ...clear });
      else await updatePackage(c.id, { reservedAt, ...clear });
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

/**
 * Việc nền chạy một lượt cho đúng các SKU (kiện huỷ nhả hàng, #237 ghép xong SKU, #239 dỡ kiện về kệ). Hàng `standard`,
 * không gộp trùng: `allocation_done` của lượt phải mang SKU vừa nhả (spec 199b D8).
 */
export const allocationJobs = defineQueue('fulfillment.allocation', JobDataSchema.extend({ variantIds: z.array(z.uuid()).min(1) }));

/** Xếp một lượt phân hàng cho các SKU, cùng giao dịch của bên gọi (trong `withCompany`). Rỗng thì không làm gì. */
export async function requestAllocation(variantIds: readonly string[]): Promise<void> {
  const ids = unique(variantIds).sort();
  if (!ids.length) return;
  await sendJob(allocationJobs, { companyId: requireCompanyId('requestAllocation'), variantIds: ids });
}

/** Handler của consumer `inventory.stock_changed`: không dùng số trong payload, lượt tự đọc lại tồn. */
export function onStockChanged(ctx: AllocationContext): (event: { payload: { variantId: string } }) => Promise<void> {
  return async (event) => {
    await runAllocation(ctx, { variantIds: [event.payload.variantId] });
  };
}

/** Handler của việc `fulfillment.allocation`. */
export function onAllocationJob(ctx: AllocationContext): (data: { companyId: string; variantIds: string[] }) => Promise<void> {
  return async (data) => {
    await withCompany(data.companyId, () => runAllocation(ctx, { variantIds: data.variantIds }));
  };
}

/**
 * Phiếu kiểm kê đầu kỳ của gian hàng vừa ghi sổ (spec 199b §5.5, D1, D2). Channel gọi trong giao dịch thoát chờ kiểm kê,
 * sau khi đặt `openingStocktake = null`: bù kiện rời kho lúc chờ (từ `countedAt` trừ tồn, trước đó chỉ lưu), rồi phân
 * hàng cho mọi kiện chưa bàn giao, rồi phát `allocation_done` có `cause`. Gọi lại không trừ, không giữ thêm.
 */
export async function settleOpeningStocktake(p: {
  shopId: string;
  documentId: string;
  countedAt: Date;
}): Promise<{ deducted: number; storedOnly: number; held: number }> {
  // Khoá phân hàng trước khi bù (thứ tự §5.10: gian hàng → advisory → kiện → dòng tồn → doc_counters); khoá giao dịch
  // lấy lại trong `runAllocation` không chặn.
  await takeAllocationLock(requireCompanyId('settleOpeningStocktake'));
  const settled = await settleDeferredHandovers(p.shopId, p.countedAt);
  const { held } = await runAllocation({}, { all: true }, { opening: true, cause: { type: 'stocktake', documentId: p.documentId } });
  return { ...settled, held: held.length };
}
