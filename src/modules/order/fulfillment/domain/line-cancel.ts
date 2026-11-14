// Luật thuần xét huỷ dòng theo kiện (spec 205 §5.10, D16): sàn huỷ một phần món của kiện chưa rời kho thì gỡ món đó
// (kiện chưa đóng gói) hoặc đánh dấu chờ bỏ (kiện đã đóng gói). Sàn huỷ mọi món của kiện thì đi đường huỷ cả kiện.
import { isHandedOver, isSealed, type PackageStatus } from './package.ts';

export interface CancelLine {
  id: string;
  orderLineId: string;
  variantId: string | null;
  quantity: number;
  reservedQty: number;
  pendingDropQty: number;
}

export type LineCancelPlan =
  /** Không món nào bị huỷ, kiện đã huỷ, hoặc kiện đã rời kho (`25` E96: hàng đã đi, không gỡ). */
  | { kind: 'none' }
  /** Mọi dòng bị huỷ: để đường huỷ cả kiện (`cancelPlatformPackage`). */
  | { kind: 'whole' }
  /** Kiện `backordered`, `reserved`: xoá các dòng này. */
  | { kind: 'drop'; lines: CancelLine[] }
  /** Kiện `packed`, `awaiting_pickup`: các dòng này chờ bỏ khi mở kiện; `fresh` là dòng chưa đánh dấu. */
  | { kind: 'pending'; lines: CancelLine[]; fresh: CancelLine[] };

/** `cancelled`: `order_line_id` của món sàn huỷ (D17: `cancelled` mà không phải huỷ vì giao không thành). */
export function planLineCancel(status: PackageStatus, lines: readonly CancelLine[], cancelled: ReadonlySet<string>): LineCancelPlan {
  if (status === 'cancelled' || isHandedOver(status)) return { kind: 'none' };
  const hit = lines.filter((l) => cancelled.has(l.orderLineId));
  if (!hit.length) return { kind: 'none' };
  if (hit.length === lines.length) return { kind: 'whole' };
  if (isSealed(status)) return { kind: 'pending', lines: hit, fresh: hit.filter((l) => l.pendingDropQty < l.quantity) };
  return { kind: 'drop', lines: hit };
}
