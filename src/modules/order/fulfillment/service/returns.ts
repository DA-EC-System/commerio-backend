// Cổng của fulfillment cho yêu cầu trả (#202): kiện của dòng trả khi sàn mở yêu cầu (25 §9), kiện trả không khớp.
// Chạy trong giao dịch của bên gọi (sales); bước của kiện ghi lịch sử và phát sự kiện như các lối chuyển khác.
import { publishEvent, recordTransition } from '../../../core/index.ts';
import type { PackageStatus } from '../domain/package.ts';
import { updatePackage } from '../repository/packages.ts';
import { lockPackageStatus } from '../repository/returns.ts';
import { reportDelivered } from './delivery.ts';

export {
  countOpenUnmatchedParcels,
  findUnmatchedParcel,
  findUnmatchedParcels,
  insertUnmatchedParcel,
  packageLinesOfOrderLines,
  resolveUnmatchedParcel,
  setParcelInspection,
  unmatchedParcelLines,
  type UnmatchedParcelRow,
  type UnmatchedParcelStatus,
} from '../repository/returns.ts';

/** Kiện còn trên luồng chính khi sàn mở yêu cầu trả: nhảy cóc tới `delivered` (25 §9, 8.4 quy tắc 2). */
const MAIN_LINE: readonly PackageStatus[] = ['in_transit', 'self_delivering', 'delivery_failed'];

export type ReturnPackageOutcome = 'delivered' | 'jumped' | 'held' | 'returned' | 'missing';

/**
 * Yêu cầu từ sàn luôn được nhận (25 §9, E98, E109). `jumped`: kiện vừa nhảy cóc tới `delivered`, bật cờ Cần xử lý;
 * `held`: kiện ở `returning`, `lost` (hoặc chưa rời kho) giữ nguyên; `returned`: hàng đã về kho, không sinh phiếu kiểm
 * hàng hoàn lần nữa. Bên gọi bật cờ trên yêu cầu với mọi kết quả khác `delivered`.
 */
// Bước đổi trạng thái kiện chép từ `changeStatus` của `platform-packages.ts` (cập nhật, lịch sử, sự kiện): dùng chung cần
// `PlatformPackageOrder` (giữ hàng, mốc kéo đơn) mà bên gọi ở đây không có; nhảy từ luồng chính tới `delivered` không đổi
// tồn nên chưa gộp. Báo finance qua `reportDelivered` như mọi lối vào `delivered` (#199 phần c).
export async function deliverForReturn(packageId: string, note: string): Promise<ReturnPackageOutcome> {
  const pkg = await lockPackageStatus(packageId);
  if (!pkg) return 'missing';
  if (pkg.status === 'delivered') return 'delivered';
  if (pkg.status === 'returned') return 'returned';
  // `returning`, `lost` giữ nguyên; kiện chưa rời kho cũng không tự đẩy (không có lượt trừ tồn), để người dùng đối chiếu.
  if (!MAIN_LINE.includes(pkg.status)) return 'held';
  const at = new Date();
  await updatePackage(pkg.id, { status: 'delivered', deliveredAt: at, needsAttention: true, flagNote: note });
  await recordTransition({ entityType: 'packages', entityId: pkg.id, from: pkg.status, to: 'delivered', action: 'platform_sync', actorId: null, source: 'marketplace', reason: note });
  await publishEvent({
    type: 'fulfillment.package_status_changed',
    aggregateId: pkg.orderId,
    payload: { packageId: pkg.id, orderId: pkg.orderId, from: pkg.status, to: 'delivered' },
  });
  // Kiện vào `delivered` ở mọi lối đều báo finance đúng một lần (spec 199c §5.3; chặn bằng `delivery_posted_at`).
  await reportDelivered(pkg.id);
  return 'jumped';
}
