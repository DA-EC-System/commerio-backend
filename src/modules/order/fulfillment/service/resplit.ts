// Thi hành kế hoạch sàn chia lại kiện (spec #238 §5.6 "Thi hành"), luật ở `domain/resplit.ts`. Chạy trong giao dịch kéo
// đơn, mọi kiện của đơn đã khoá (`lockOrderPackages`), lượt đã giữ khoá advisory phân hàng khi kế hoạch có bước: kiện
// mới của đơn lấy phần vừa nhả trước mọi kiện `backordered` khác (`25` §8.1 bước 3). Kiểm bằng theo dòng đơn (trigger,
// `db/CLAUDE.md`) giữ lúc commit: dòng chuyển đi bị xoá, chờ bỏ, hoặc thuộc kiện vừa huỷ; dòng của kiện mới đủ số lượng.
import { assertTransition, publishEvent, recordTransition } from '../../../core/index.ts';
import type { PlatformPackageOrder } from '../domain/delivery.ts';
import { packageMachine } from '../domain/package.ts';
import type { ResplitPlan } from '../domain/resplit.ts';
import { deleteLines } from '../repository/line-cancel.ts';
import { type PackageRow, setReserved, updatePackage } from '../repository/packages.ts';
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
  create: (code: string, replacesPackageId: string, awaitingOpen: boolean) => Promise<PackageRow>,
): Promise<{ created: Map<string, PackageRow>; releasedVariantIds: string[] }> {
  const byId = (id: string) => packages.find((p) => p.id === id)!;
  const allocate = new Set<string>();
  const created = new Map<string, PackageRow>();

  // Hai pha mã (unique `packages_platform_code_order_uq` không lọc trạng thái): gỡ mã của kiện bị gỡ, và của kiện sắp đổi
  // mà mã đang có là mã kiện khác sắp nhận (hai kiện đổi mã cho nhau), rồi mới gắn mã mới.
  const incoming = new Set(plan.steps.flatMap((s) => (s.kind === 'relabel' ? [s.code] : [])));
  for (const s of plan.steps) {
    if (s.kind !== 'clear_code' && s.kind !== 'relabel') continue;
    const pkg = byId(s.packageId);
    if (pkg.platformPackageCode === null || (s.kind === 'relabel' && !incoming.has(pkg.platformPackageCode))) continue;
    await updatePackage(pkg.id, { platformPackageCode: null });
    pkg.platformPackageCode = null;
  }

  for (const s of pendingSteps(plan, packages)) {
    if (s.kind === 'clear_code') continue;
    if (s.kind === 'relabel') {
      await updatePackage(s.packageId, { platformPackageCode: s.code });
      byId(s.packageId).platformPackageCode = s.code;
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
      // Kiện đã đóng: Task 3 (spec §5.6). Bên gọi chưa thi hành kế hoạch có bước này.
      throw new Error('mark_drop chưa được thi hành ở đường đồng bộ');
    } else {
      const pkg = await create(s.code, s.replacesPackageId, s.awaitingOpen);
      packages.push(pkg);
      created.set(s.code, pkg);
    }
  }
  return { created, releasedVariantIds: [...allocate].sort() };
}
