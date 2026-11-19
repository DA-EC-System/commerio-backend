// Dựng `PackageSummary` ở một nơi (spec 199a D8): route kiện của fulfillment và chi tiết đơn của sales cùng dùng.
// Thông tin của đơn (mã, khách, SKU, tên sản phẩm đã chép trên dòng đơn) do sales đưa vào qua `PackageOrderRef`; SKU,
// tên, nhãn của biến thể app mà dòng kiện giữ do `packageVariantsOf` tra một lần cho cả trang (Documents/21 §19.2).
import { getVariants } from '../../../product/index.ts';
import { pickupUnconfirmed } from '../domain/handover.ts';
import { isHandedOver, isSealed, PRE_HANDOVER } from '../domain/package.ts';
import type { PackageViewRow } from '../repository/packages.ts';

/** Dòng đơn mà dòng kiện trỏ tới, đã tính nhãn biến thể như chi tiết đơn. */
export interface PackageOrderLineRef {
  sku: string;
  productName: string;
  attributesLabel: string;
  /** SKU người bán trên sàn; null với đơn tay. */
  externalSku: string | null;
}

/** SKU, tên sản phẩm, nhãn thuộc tính của biến thể app (khoá là `variantId`). */
export interface PackageVariantRef {
  sku: string;
  productName: string;
  attributesLabel: string;
}

/**
 * Biến thể app của mọi dòng kiện đã ghép trong các kiện, một câu cho cả trang; gọi trong `withCompany` của bên gọi.
 * Biến thể không đọc được (đã xoá) thì vắng, dòng kiện lấy lại SKU, tên trên dòng đơn.
 */
export async function packageVariantsOf(rows: readonly { lines: readonly { variantId: string | null }[] }[]): Promise<Map<string, PackageVariantRef>> {
  const ids = [...new Set(rows.flatMap((r) => r.lines.flatMap((l) => (l.variantId ? [l.variantId] : []))))];
  if (!ids.length) return new Map();
  return new Map(
    (await getVariants(ids)).map((v) => [v.id, { sku: v.sku, productName: v.productName, attributesLabel: v.attributes.map((a) => a.value).join(' / ') }]),
  );
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
  /** Khách đang xin huỷ trên sàn, chờ Sale trả lời (cờ `cancel_requested` của đơn, #239 KH-B07). */
  cancelRequested: boolean;
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
 * Hình trả về khớp schema `PackageSummary` (`api/schemas.ts`); test route parse bằng schema đó. `variants`: biến thể
 * app theo id (`packageVariantsOf`): dòng đã ghép hiện SKU, tên, nhãn của biến thể app, dòng chưa ghép hay "không quản
 * tồn" hiện của sàn (dòng đơn). `names`: họ tên tài khoản theo id (người báo thất lạc); thiếu thì tên rỗng như
 * `StatusChange.by`.
 */
export function toPackageSummary(
  p: PackageViewRow,
  order: PackageOrderRef,
  shop: PackageShopRef | null,
  now: number,
  variants: ReadonlyMap<string, PackageVariantRef>,
  names: ReadonlyMap<string, string> = new Map(),
) {
  // Dòng kiện theo thứ tự dòng đơn (sales sắp theo mã món sàn), như chi tiết đơn; dòng kiện chèn một câu không có thứ tự riêng.
  const position = new Map([...order.lines.keys()].map((id, i) => [id, i]));
  const ordered = [...p.lines].sort((a, b) => (position.get(a.orderLineId) ?? Infinity) - (position.get(b.orderLineId) ?? Infinity));
  const lines = ordered.map((pl) => {
    const l = order.lines.get(pl.orderLineId);
    const v = pl.variantId ? variants.get(pl.variantId) : undefined;
    return {
      id: pl.id,
      variantId: pl.variantId,
      untracked: pl.stockUntracked,
      sku: v?.sku ?? l?.sku ?? '',
      productName: v?.productName ?? l?.productName ?? '',
      // Biến thể app không có thuộc tính thì dùng nhãn phân loại của sàn để kho vẫn biết món nào.
      attributesLabel: v?.attributesLabel || l?.attributesLabel || '',
      externalSku: l?.externalSku ?? null,
      quantity: pl.quantity,
      pendingDropQty: pl.pendingDropQty,
      // Dấu chỉ có nghĩa khi kiện còn đóng (spec 237 §5.6, D25): kiện huỷ hay rời kho thì dấu nằm im.
      remapPending: pl.remapPending && isSealed(p.status),
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
      ...(order.cancelRequested && PRE_HANDOVER.includes(p.status) ? (['cancel_requested'] as const) : []),
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
