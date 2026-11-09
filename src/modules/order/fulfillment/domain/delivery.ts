// Luật thuần của giao, hoàn (#199 phần c, spec 199c §5.2, Documents/21 §11.2, Documents/25 §8.3, §8.4). Chuẩn hoá
// trạng thái sàn, đích kiện, mốc giờ từ hành trình (trace) và tiền kiện giao xong. One place of law: thi hành ở
// `service/delivery.ts` và đồng bộ sàn.
import { Decimal } from 'decimal.js';
import type { PackageStatus } from './package.ts';

/** Trạng thái món sàn đã chuẩn hoá (cùng giá trị `RemoteLineStatus` của adapter; chuyển từ `service/platform-packages.ts`). */
export type PlatformLineStatus =
  | 'pending'
  | 'packed'
  | 'awaiting_pickup'
  | 'in_transit'
  | 'delivered'
  | 'delivery_failed'
  | 'returning'
  | 'returned'
  | 'return_failed'
  | 'lost'
  | 'cancelled';

/** Nguyên nhân sàn huỷ món (`cancellation_reason`); `failed_delivery` là giao không thành (D2, spec 199c §5.2). */
export type CancelKind = 'cancellation' | 'return' | 'refund' | 'failed_delivery';

/** Sự kiện hành trình của một kiện (từ trace của sàn, spec 199c §5.7), đã lọc đúng kiện. */
export interface PackageEvent {
  packageCode: string | null;
  trackingCode: string | null;
  status: PlatformLineStatus;
  at: Date;
  description: string | null;
}

/** Câu mặc định khi hành trình không cho lý do giao không thành (spec 199c §5.2, 21 §11.2). */
export const DEFAULT_FAIL_REASON = 'Sàn báo giao không thành công';

/**
 * Trạng thái kiện của một món sàn đã tính `cancelKind` (D2, spec 199c §5.2): món huỷ vì giao không thành kể là
 * `returning` để kiện đi tiếp tới quét nhận hàng hoàn; còn lại giữ nguyên. `groupStatus` của đồng bộ dùng trước khi
 * chọn món chậm nhất.
 */
export function lineStatus(l: { status: PlatformLineStatus | null; cancelKind?: CancelKind | null }): PlatformLineStatus | null {
  if (l.status === 'cancelled' && l.cancelKind === 'failed_delivery') return 'returning';
  return l.status;
}

/**
 * Đích kiện khi sàn báo trạng thái (spec 199c §5.2, D1, D9):
 * - `returned`: kiện lần đầu thấy của đơn đặt trước mốc kéo đơn (`storeOnly`) vào thẳng `returned` (kiểm kê đã đếm),
 *   còn lại `returning` (chờ kho quét nhận, D1);
 * - `return_failed`: `returning` (cờ như hiện nay);
 * - còn lại: trạng thái cùng tên.
 */
export function deliveryTarget(remote: Exclude<PlatformLineStatus, 'pending' | 'cancelled'>, p: { firstSeen: boolean; storeOnly: boolean }): PackageStatus {
  if (remote === 'returned') return p.firstSeen && p.storeOnly ? 'returned' : 'returning';
  if (remote === 'return_failed') return 'returning';
  return remote;
}

/**
 * Sự kiện hành trình thuộc kiện (spec 199c §5.2, 21 §11.2): khớp mã kiện sàn trước; không thấy thì khớp mã vận đơn.
 * Mã nào của kiện null thì không khớp theo mã đó. Mỗi kiện chỉ nhận sự kiện của chính nó.
 */
export function eventsOf(events: readonly PackageEvent[], pkg: { platformPackageCode: string | null; trackingCode: string | null }): PackageEvent[] {
  if (pkg.platformPackageCode !== null) {
    const byCode = events.filter((e) => e.packageCode === pkg.platformPackageCode);
    if (byCode.length) return byCode;
  }
  if (pkg.trackingCode !== null) return events.filter((e) => e.trackingCode === pkg.trackingCode);
  return [];
}

// Nhóm rời kho (có `leftAt`): đã qua bàn giao; `packed`/`awaiting_pickup` chưa rời kho nên không tính mốc.
const POST_HANDOVER: ReadonlySet<string> = new Set(['in_transit', 'delivered', 'delivery_failed', 'returning', 'returned', 'lost']);

/**
 * Mốc giờ từ hành trình (spec 199c §5.2, 21 §11.2):
 * - `leftAt`: mốc rời kho = `at` sớm nhất của sự kiện sau bàn giao;
 * - `deliveredAt`: mốc giao = `at` muộn nhất của sự kiện `delivered`;
 * - `failReason`: mô tả sự kiện `delivery_failed` muộn nhất, cắt khoảng trắng, rỗng thì null.
 * Mốc nào sau giờ đồng bộ (`now`) thì lấy `now`.
 */
export function journeyTimes(events: readonly PackageEvent[], now: Date): { leftAt: Date | null; deliveredAt: Date | null; failReason: string | null } {
  const clamp = (d: Date) => (d.getTime() > now.getTime() ? now : d);
  let leftAt: Date | null = null;
  let deliveredAt: Date | null = null;
  let failAt: Date | null = null;
  let failReason: string | null = null;
  for (const e of events) {
    if (POST_HANDOVER.has(e.status)) {
      const t = clamp(e.at);
      if (leftAt === null || t.getTime() < leftAt.getTime()) leftAt = t;
    }
    if (e.status === 'delivered') {
      const t = clamp(e.at);
      if (deliveredAt === null || t.getTime() > deliveredAt.getTime()) deliveredAt = t;
    }
    if (e.status === 'delivery_failed') {
      if (failAt === null || e.at.getTime() > failAt.getTime()) {
        failAt = e.at;
        failReason = e.description?.trim() || null;
      }
    }
  }
  return { leftAt, deliveredAt, failReason };
}

/** Dòng kiện kèm số của dòng đơn để tính tiền (spec 199c §5.2). `order.quantity` là số cả dòng đơn. */
export interface DeliveredLine {
  variantId: string | null;
  quantity: number;
  unitCost: string | null;
  order: { quantity: number; unitPrice: string; sellerDiscount: string; platformDiscount: string };
}

/** Ship cấp đơn (#260, null được cho đơn trước #260). */
export interface OrderShipping {
  shippingFee: string;
  shippingFeeOriginal: string | null;
  shippingFeeDiscountPlatform: string | null;
}

const ZERO = '0.00';
const round = (x: Decimal) => x.toFixed(2, Decimal.ROUND_HALF_UP);

/**
 * Tiền kiện giao xong (spec 199c §5.2, D4, D10):
 * - `unitPrice` mỗi dòng = `order.unitPrice − order.sellerDiscount ÷ order.quantity` (giá sau voucher shop);
 * - `platformSubsidy` = Σ `order.platformDiscount × quantity ÷ order.quantity`, cộng trợ ship sàn khi kiện đầu;
 * - kiện đầu (`first`): `shippingIncome = shipping_fee`, `shippingCost = shipping_fee_original ?? shipping_fee` (D10);
 *   kiện sau: cả hai `"0.00"`. Làm tròn `ROUND_HALF_UP` 2 chữ số, ra chuỗi.
 */
export function deliveredAmounts(
  lines: readonly DeliveredLine[],
  shipping: OrderShipping,
  first: boolean,
): { lines: { variantId: string | null; quantity: number; unitPrice: string; unitCost: string | null }[]; platformSubsidy: string; shippingIncome: string; shippingCost: string } {
  const out: { variantId: string | null; quantity: number; unitPrice: string; unitCost: string | null }[] = [];
  let subsidy = new Decimal(0);
  for (const l of lines) {
    const o = l.order;
    const qty = new Decimal(o.quantity);
    const unitPrice = new Decimal(o.unitPrice).sub(new Decimal(o.sellerDiscount).div(qty));
    out.push({ variantId: l.variantId, quantity: l.quantity, unitPrice: round(unitPrice), unitCost: l.unitCost });
    subsidy = subsidy.add(new Decimal(o.platformDiscount).mul(new Decimal(l.quantity)).div(qty));
  }
  if (first && shipping.shippingFeeDiscountPlatform !== null) subsidy = subsidy.add(new Decimal(shipping.shippingFeeDiscountPlatform));
  return {
    lines: out,
    platformSubsidy: round(subsidy),
    shippingIncome: first ? round(new Decimal(shipping.shippingFee)) : ZERO,
    shippingCost: first ? round(new Decimal(shipping.shippingFeeOriginal ?? shipping.shippingFee)) : ZERO,
  };
}
