// Dựng `PackageSummary` ở một nơi (spec 199a D8): route kiện của fulfillment và chi tiết đơn của sales cùng dùng.
// Thông tin của đơn (mã, khách, SKU, tên sản phẩm đã chép trên dòng đơn) do sales đưa vào qua `PackageOrderRef`.
import { pickupUnconfirmed } from '../domain/handover.ts';
import { isHandedOver } from '../domain/package.ts';
import type { PackageViewRow } from '../repository/packages.ts';

/** Dòng đơn mà dòng kiện trỏ tới, đã tính nhãn biến thể như chi tiết đơn. */
export interface PackageOrderLineRef {
  sku: string;
  productName: string;
  attributesLabel: string;
}

/** Thông tin đơn của kiện, do sales dựng (`orderRefsOf`, `getOrder`). */
export interface PackageOrderRef {
  id: string;
  code: string;
  status: 'unpaid' | 'processing' | 'completed' | 'cancelled';
  source: 'marketplace' | 'inbox' | 'manual';
  shopId: string | null;
  customerName: string | null;
  paymentMethod: 'prepaid' | 'cod' | null;
  cancelling: boolean;
  platformCancelled: boolean;
  /** Khoá là `order_line_id`. */
  lines: Map<string, PackageOrderLineRef>;
}

/** Gian hàng của kiện như trên `OrderShopRef`. */
export interface PackageShopRef {
  id: string;
  shopName: string;
  platform: string;
}

const isoOrNull = (d: Date | null) => d?.toISOString() ?? null;

/** Báo cáo thất lạc đang treo hoặc đã xác nhận (spec #238 §5.3); tên người báo bên gọi tra một lần cho cả trang. */
function lostReportOf(p: PackageViewRow, names: ReadonlyMap<string, string>) {
  if (p.lostReportedBy === null || p.lostReportedAt === null || p.lostClaimCode === null) return null;
  return { by: { id: p.lostReportedBy, name: names.get(p.lostReportedBy) ?? '' }, at: p.lostReportedAt.toISOString(), claimCode: p.lostClaimCode };
}

/**
 * Hình trả về khớp schema `PackageSummary` (`api/schemas.ts`); test route parse bằng schema đó. `names`: họ tên tài
 * khoản theo id (người báo thất lạc); thiếu thì tên rỗng như `StatusChange.by`.
 */
export function toPackageSummary(
  p: PackageViewRow,
  order: PackageOrderRef,
  shop: PackageShopRef | null,
  now: number,
  names: ReadonlyMap<string, string> = new Map(),
) {
  // Dòng kiện theo thứ tự dòng đơn (sales sắp theo mã món sàn), như chi tiết đơn; dòng kiện chèn một câu không có thứ tự riêng.
  const position = new Map([...order.lines.keys()].map((id, i) => [id, i]));
  const ordered = [...p.lines].sort((a, b) => (position.get(a.orderLineId) ?? Infinity) - (position.get(b.orderLineId) ?? Infinity));
  const lines = ordered.map((pl) => {
    const l = order.lines.get(pl.orderLineId);
    return {
      variantId: pl.variantId,
      sku: l?.sku ?? '',
      productName: l?.productName ?? '',
      attributesLabel: l?.attributesLabel ?? '',
      quantity: pl.quantity,
      pendingDropQty: pl.pendingDropQty,
    };
  });
  return {
    id: p.id,
    code: p.code,
    order: { id: order.id, code: order.code, status: order.status },
    source: order.source,
    shop,
    customerName: order.customerName,
    status: p.status,
    flags: [
      ...(p.needsOpen ? (['needs_open'] as const) : []),
      ...(p.needsAttention ? (['needs_attention'] as const) : []),
      ...(p.lostReportedBy && p.status !== 'lost' ? (['lost_reported'] as const) : []),
      ...(p.labelError ? (['label_error'] as const) : []),
      ...(pickupUnconfirmed(p, now) ? (['pickup_unconfirmed'] as const) : []),
    ],
    flagNote: p.flagNote,
    notices: p.notices,
    openPurpose: p.openPurpose,
    selfDelivery: p.selfDelivery,
    paymentMethod: order.paymentMethod,
    paymentStatus: null,
    trackingCode: p.trackingCode,
    platformPackageCode: p.platformPackageCode,
    carrier: p.carrierCode !== null && p.carrierName !== null ? { code: p.carrierCode, name: p.carrierName } : null,
    shipmentProvider: p.shipmentProvider,
    shippingProviderType: p.shippingProviderType,
    promisedShippingAt: isoOrNull(p.promisedShippingAt),
    shipBy: isoOrNull(p.shipBy),
    lines,
    totalQty: lines.reduce((a, l) => a + l.quantity, 0),
    handedOverAt: isHandedOver(p.status) ? isoOrNull(p.handedOverAt) : null,
    handoverSource: isHandedOver(p.status) ? p.handoverSource : null,
    pickupConfirmedAt: isHandedOver(p.status) ? isoOrNull(p.pickupConfirmedAt) : null,
    deliveredAt: isoOrNull(p.deliveredAt),
    deliveredBy: null,
    lostReport: lostReportOf(p, names),
    replaces: p.replaces,
    createdAt: p.createdAt.toISOString(),
    version: p.version,
  };
}
