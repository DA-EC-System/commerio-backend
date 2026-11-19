// Thi hành kế hoạch sàn chia lại kiện (spec #238 §5.6 "Thi hành"), luật ở `domain/resplit.ts`. Chạy trong giao dịch kéo
// đơn, mọi kiện của đơn đã khoá (`lockOrderPackages`), lượt đã giữ khoá advisory phân hàng khi kế hoạch có bước: kiện
// mới của đơn lấy phần vừa nhả trước mọi kiện `backordered` khác (`25` §8.1 bước 3). Kiểm bằng theo dòng đơn (trigger,
// `db/CLAUDE.md`) giữ lúc commit: dòng chuyển đi bị xoá, chờ bỏ, hoặc thuộc kiện vừa huỷ; dòng của kiện mới đủ số lượng.
import { assertTransition, publishEvent, recordTransition } from '../../../core/index.ts';
import { logger } from '../../../../shared/logger.ts';
import type { PlatformPackageOrder } from '../domain/delivery.ts';
import { purposeAfterClear, raisePurpose } from '../domain/open-purpose.ts';
import { packageMachine } from '../domain/package.ts';
import { replacementPairs, type ResplitPlan } from '../domain/resplit.ts';
import { deleteLines, setPendingDrop } from '../repository/line-cancel.ts';
import { moveReservations, type PackageRow, setReserved, updatePackage } from '../repository/packages.ts';
import { requestAllocation } from './allocation.ts';
import { stockPort } from './stock-port.ts';

/** Cần xử lý trên kiện đã bàn giao mà sàn báo chia khác (D29). */
export const RESPLIT_HANDED_OVER_NOTE = 'Sàn chia lại kiện đã bàn giao';
const RESPLIT_REASON = 'Sàn chia lại kiện';

/** Phần đang giữ thật của các dòng: chỉ dòng có biến thể và `reserved_qty`, đúng số đó. */
const heldOf = (lines: readonly PackageRow['lines'][number][]) =>
  lines.filter((l) => l.variantId && l.reservedQty > 0).map((l) => ({ variantId: l.variantId!, quantity: l.reservedQty }));

/** Bước `flag` còn phải ghi: kiện đã có cờ Cần xử lý thì không ghi lại (không tăng `version`, gọi lặp). */
export const pendingSteps = (plan: ResplitPlan, packages: readonly PackageRow[]) =>
  plan.steps.filter((s) => s.kind !== 'flag' || !packages.find((p) => p.id === s.packageId)?.needsAttention);

/**
 * Thi hành `plan` trên `packages` (đã khoá; hàm sửa tại chỗ dòng, mã, trạng thái và thêm kiện mới vào mảng). `create`
 * lập kiện mới cho một nhóm (bên gọi giữ hàng, ghi lịch sử). Trả kiện mới theo mã nhóm và SKU cần xếp lượt phân hàng sau
 * commit: SKU vừa nhả (phần dư cho kiện khác) và SKU còn lại của kiện `backordered` vừa bớt dòng.
 */
export async function applyResplit(
  order: PlatformPackageOrder,
  plan: ResplitPlan,
  packages: PackageRow[],
  create: (code: string, replacesPackageId: string, awaitingOrderLineIds: readonly string[]) => Promise<PackageRow>,
): Promise<{ created: Map<string, PackageRow>; releasedVariantIds: string[] }> {
  const byId = (id: string) => packages.find((p) => p.id === id)!;
  const allocate = new Set<string>();
  const created = new Map<string, PackageRow>();

  // Hai pha mã (unique `packages_platform_code_order_uq` không lọc trạng thái): gỡ mã của kiện bị gỡ, và của kiện sắp đổi
  // mà mã đang có là mã kiện khác sắp nhận (hai kiện đổi mã cho nhau), rồi mới gắn mã mới. Kiện đổi hay mất mã thì vận đơn
  // giữ lại (D25) không còn là vận đơn của gói trên sàn: tắt `waybill_kept` cùng câu (CHECK `packages_waybill_kept` cần mã).
  const incoming = new Set(plan.steps.flatMap((s) => (s.kind === 'relabel' ? [s.code] : [])));
  for (const s of plan.steps) {
    if (s.kind !== 'clear_code' && s.kind !== 'relabel') continue;
    const pkg = byId(s.packageId);
    if (pkg.platformPackageCode === null || (s.kind === 'relabel' && !incoming.has(pkg.platformPackageCode))) continue;
    await updatePackage(pkg.id, { platformPackageCode: null, waybillKept: false });
    Object.assign(pkg, { platformPackageCode: null, waybillKept: false });
  }

  for (const s of pendingSteps(plan, packages)) {
    if (s.kind === 'clear_code') continue;
    if (s.kind === 'relabel') {
      await updatePackage(s.packageId, { platformPackageCode: s.code, waybillKept: false });
      Object.assign(byId(s.packageId), { platformPackageCode: s.code, waybillKept: false });
    } else if (s.kind === 'flag') {
      await updatePackage(s.packageId, { needsAttention: true, flagNote: RESPLIT_HANDED_OVER_NOTE });
      byId(s.packageId).needsAttention = true;
    } else if (s.kind === 'cancel_open') {
      const pkg = byId(s.packageId);
      const from = pkg.status;
      assertTransition(packageMachine, from, 'cancel', { actor: null });
      const held = heldOf(pkg.lines);
      if (held.length) await stockPort().release(pkg.id, held);
      for (const l of held) allocate.add(l.variantId);
      await setReserved(pkg.id, false);
      await updatePackage(pkg.id, { status: 'cancelled' });
      await recordTransition({
        entityType: 'packages',
        entityId: pkg.id,
        from,
        to: 'cancelled',
        action: 'cancel',
        actorId: null,
        source: 'marketplace',
        reason: RESPLIT_REASON,
      });
      await publishEvent({ type: 'fulfillment.package_status_changed', aggregateId: order.id, payload: { packageId: pkg.id, orderId: order.id, from, to: 'cancelled' } });
      pkg.status = 'cancelled';
      for (const l of pkg.lines) l.reservedQty = 0;
    } else if (s.kind === 'move_out') {
      const pkg = byId(s.packageId);
      const ids = new Set(s.orderLineIds);
      const moving = pkg.lines.filter((l) => ids.has(l.orderLineId) && l.pendingDropQty === 0);
      const held = heldOf(moving);
      if (held.length) await stockPort().release(pkg.id, held);
      for (const l of held) allocate.add(l.variantId);
      await deleteLines(moving.map((l) => l.id));
      pkg.lines = pkg.lines.filter((l) => !moving.includes(l));
      // Kiện thiếu hàng bớt món có thể giữ đủ phần còn lại.
      if (pkg.status === 'backordered') for (const l of pkg.lines) if (l.variantId) allocate.add(l.variantId);
      await updatePackage(pkg.id, {});
      await recordTransition({
        entityType: 'packages',
        entityId: pkg.id,
        from: pkg.status,
        to: pkg.status,
        action: 'drop_lines',
        actorId: null,
        source: 'marketplace',
        reason: `${RESPLIT_REASON}: chuyển ${moving.reduce((n, l) => n + l.quantity, 0)} món`,
      });
    } else if (s.kind === 'mark_drop') {
      // Kiện đã đóng: dòng chuyển đi chờ bỏ (vẫn giữ hàng) tới khi kho mở; mục đích theo D24 và spec 237 D17 (`resplit`
      // thắng `edit`, `stocktake`, `remap`; `cancel` thắng `resplit`). Không ghi lịch sử (như `markPendingDrop` của #205).
      const pkg = byId(s.packageId);
      const ids = new Set(s.orderLineIds);
      const fresh = pkg.lines.filter((l) => ids.has(l.orderLineId) && l.pendingDropQty < l.quantity);
      await setPendingDrop(fresh.map((l) => l.id));
      for (const l of fresh) l.pendingDropQty = l.quantity;
      const purpose = raisePurpose(pkg, 'resplit') ?? {};
      await updatePackage(pkg.id, purpose);
      Object.assign(pkg, purpose);
      logger.info({ packageId: pkg.id, orderLineIds: s.orderLineIds }, 'kiện đã đóng chờ dỡ để chia lại');
    } else {
      const pkg = await create(s.code, s.replacesPackageId, s.awaitingOrderLineIds);
      packages.push(pkg);
      created.set(s.code, pkg);
    }
  }
  return { created, releasedVariantIds: [...allocate].sort() };
}

/**
 * Kiện chờ thay mà sàn báo rời kho trước khi kho dỡ kiện cũ (spec #238 §5.6, `25` §8.1): mỗi dòng của kiện nhận phần giữ
 * của dòng chờ bỏ cùng dòng đơn ở kiện cũ đang đóng, dòng cũ xoá (tổng đang giữ theo SKU không đổi, không gọi cổng tồn).
 * Kiện cũ hết dòng thì `replaced` (`cancelled`, gỡ cờ Cần mở); còn dòng mà hết dòng chờ bỏ, mục đích `resplit`, thì gỡ
 * cờ; còn dòng chờ bỏ thì chỉ tăng `version` (lần mở đang dở gặp `version_conflict`). Bên gọi áp trạng thái sàn sau:
 * dòng đã nhận phần giữ thì trừ thường, dòng chưa giữ (từ kiện chưa đóng) thử giữ, không được mới bàn giao bắt buộc.
 * `packages` đã khoá, sửa tại chỗ. Trả true khi có ghi.
 */
export async function takeOverReplaced(order: PlatformPackageOrder, pkg: PackageRow, packages: PackageRow[]): Promise<boolean> {
  const pairs = replacementPairs(packages, pkg.id);
  if (!pairs.length) return false;
  const moves: { fromLineId: string; toLineId: string }[] = [];
  // Dòng kiện thay đã trừ tồn hay đã tự giữ (kiện thay bị quét bàn giao trước khi có chặn, review #393): phần giữ của dòng
  // chờ bỏ thừa, nhả về số có thể bán thay vì chuyển sang (chuyển sang dòng đã trừ thì không bao giờ được nhả).
  const released = new Map<string, { variantId: string; quantity: number }[]>();
  const dropped: string[] = [];
  const olds = new Map<string, PackageRow>();
  for (const pair of pairs) {
    const old = packages.find((p) => p.id === pair.oldPackageId)!;
    const oldLine = old.lines.find((l) => l.id === pair.oldLineId)!;
    const newLine = pkg.lines.find((l) => l.id === pair.newLineId)!;
    if (newLine.stockDeducted || newLine.reservedQty > 0) {
      if (oldLine.variantId && oldLine.reservedQty > 0) {
        released.set(old.id, [...(released.get(old.id) ?? []), { variantId: oldLine.variantId, quantity: oldLine.reservedQty }]);
      }
      dropped.push(oldLine.id);
    } else {
      moves.push({ fromLineId: pair.oldLineId, toLineId: pair.newLineId });
      newLine.reservedQty = oldLine.reservedQty;
    }
    old.lines = old.lines.filter((l) => l !== oldLine);
    olds.set(old.id, old);
  }
  const releasedVariants = [...new Set([...released.values()].flat().map((l) => l.variantId))].sort();
  logger.warn(
    { orderId: order.id, packageId: pkg.id, replaced: [...olds.keys()], releasedVariants },
    'kiện thay được lấy trước khi dỡ kiện cũ',
  );
  await moveReservations(moves);
  for (const [oldId, lines] of released) await stockPort().release(oldId, lines);
  await deleteLines(dropped);
  if (releasedVariants.length) await requestAllocation(releasedVariants);
  for (const old of olds.values()) {
    if (!old.lines.length) {
      const from = old.status;
      assertTransition(packageMachine, from, 'replaced', { actor: null });
      await updatePackage(old.id, { status: 'cancelled', needsOpen: false, openPurpose: null, packedBy: null, packedAt: null, labelError: false });
      await recordTransition({
        entityType: 'packages',
        entityId: old.id,
        from,
        to: 'cancelled',
        action: 'replaced',
        actorId: null,
        source: 'marketplace',
        reason: `Kiện thay ${pkg.code} đã được lấy`,
      });
      await publishEvent({ type: 'fulfillment.package_status_changed', aggregateId: order.id, payload: { packageId: old.id, orderId: order.id, from, to: 'cancelled' } });
      Object.assign(old, { status: 'cancelled', needsOpen: false, openPurpose: null, labelError: false });
    } else if (old.openPurpose === 'resplit' && !old.lines.some((l) => l.pendingDropQty > 0)) {
      // Còn dòng chờ đổi ghép thì không gỡ mà đổi mục đích sang `remap` (spec 237 D18).
      const purpose = purposeAfterClear(old.lines.some((l) => l.remapPending));
      await updatePackage(old.id, purpose);
      Object.assign(old, purpose);
    } else await updatePackage(old.id, {});
  }
  return true;
}
