// Xem đơn (Documents/21 §19.1): danh sách có giai đoạn, cờ suy ra; chi tiết kèm dòng, kiện, lịch sử.
import { Decimal } from 'decimal.js';
import { getStatusHistory } from '../../../core/index.ts';
import { getVariants } from '../../../product/index.ts';
import { findPackagesOfOrders, type PackageOrderRef, type PackageViewRow, toPackageSummary } from '../../fulfillment/index.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import type { ModuleContext } from '../../../../shared/module.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import { completionBlocker, isDueSoon, type OrderFlag, type OrderStage, RETURN_WINDOW_DAYS, stageOf } from '../domain/order.ts';
import {
  findOrder,
  findOrderLines,
  findOrderPage,
  lineFacts,
  type OrderFilter,
  type OrderLineRow,
  type OrderViewRow,
  openReturnCounts,
} from '../repository/order-views.ts';

export interface ShopRef {
  shopName: string;
  platform: string;
}

/** Thao tác đơn trên sàn của channel; gọi ngoài giao dịch, lỗi sàn đã là `AppError`. */
export interface MarketplaceOrders {
  cancelReasons(companyId: string, shopId: string, externalOrderId: string, lineIds: readonly string[]): Promise<{ id: string; label: string }[]>;
  cancel(companyId: string, shopId: string, externalOrderId: string, lineIds: readonly string[], reasonId: string): Promise<void>;
  decideCancel(companyId: string, shopId: string, externalOrderId: string, accept: boolean): Promise<void>;
}

/** Hàm module lớp trên tiêm qua `src/wiring.ts`: tên gian hàng, thao tác đơn trên sàn của channel. */
export interface SalesContext extends ModuleContext {
  readonly shopsOf?: (ids: readonly string[]) => Promise<Map<string, ShopRef>>;
  readonly marketplaceOrders?: MarketplaceOrders;
}

const toInt = (money: string | null) => (money === null ? 0 : new Decimal(money).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber());
const isoOrNull = (d: Date | null) => d?.toISOString() ?? null;
const intOrNull = (money: string | null) => (money === null ? null : toInt(money));

type StoredAddress = { name: string; phone: string; address: string; ward?: string | null; postCode?: string | null } | null;

/** Nhãn thuộc tính của biến thể trong app ("Đỏ / M"), theo id. */
async function variantLabels(variantIds: (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(variantIds.filter((id): id is string => id !== null))];
  if (!ids.length) return new Map();
  return new Map((await getVariants(ids)).map((v) => [v.id, v.attributes.map((a) => a.value).join(' / ')]));
}

/** Thuộc tính sàn trả (`variation`), không có thì của biến thể đã ghép (#260). */
const attributesOf = (l: Pick<OrderLineRow, 'attributesLabel' | 'variantId'>, labels: Map<string, string>) =>
  l.attributesLabel ?? (l.variantId ? (labels.get(l.variantId) ?? '') : '');

interface Facts {
  packages: PackageViewRow[];
  lineCount: number;
  totalQty: number;
  unmapped: boolean;
  first: OrderLineRow | null;
  openReturns: number;
}

async function factsOf(orderIds: string[]): Promise<Map<string, Facts>> {
  const [packages, lines, returns] = await Promise.all([findPackagesOfOrders(orderIds), lineFacts(orderIds), openReturnCounts(orderIds)]);
  return new Map(
    orderIds.map((id) => [
      id,
      {
        packages: packages.filter((p) => p.orderId === id),
        lineCount: lines.get(id)?.lineCount ?? 0,
        totalQty: lines.get(id)?.totalQty ?? 0,
        unmapped: lines.get(id)?.unmapped ?? false,
        first: lines.get(id)?.first ?? null,
        openReturns: returns.get(id) ?? 0,
      },
    ]),
  );
}

function flagsOf(o: OrderViewRow, f: Facts, now: number): OrderFlag[] {
  const statuses = f.packages.map((p) => p.status);
  const open = o.status === 'unpaid' || o.status === 'processing';
  const flags: OrderFlag[] = [];
  if (o.needsAttention) flags.push('needs_attention');
  if (f.unmapped) flags.push('unmapped_sku');
  if (o.cancelRequested) flags.push('cancel_requested');
  if (o.cancelling) flags.push('cancelling');
  if (o.platformCancelled) flags.push('platform_cancelled');
  if (open && isDueSoon(isoOrNull(o.shipBy), statuses, now)) flags.push('due_soon');
  if (f.openReturns > 0) flags.push('return_requested');
  if (o.shopDisconnected) flags.push('shop_disconnected');
  return flags;
}

function stage(o: OrderViewRow, f: Facts, flags: OrderFlag[]): OrderStage {
  return stageOf({ status: o.status, source: o.source, paymentMethod: o.paymentMethod, flags, packages: f.packages.map((p) => p.status) });
}

function summary(o: OrderViewRow, f: Facts, shops: Map<string, ShopRef>, labels: Map<string, string>, now: number) {
  const flags = flagsOf(o, f, now);
  const live = f.packages.filter((p) => p.status !== 'cancelled');
  const shop = o.shopId ? shops.get(o.shopId) : undefined;
  return {
    id: o.id,
    code: o.code,
    source: o.source,
    shop: shop && o.shopId ? { id: o.shopId, ...shop } : null,
    customer: o.customer,
    status: o.status,
    display: { stage: stage(o, f, flags), delivered: live.filter((p) => p.status === 'delivered').length, packages: live.length },
    flags,
    outcome: o.outcome,
    rawMarketplaceStatus: o.rawMarketplaceStatus,
    paymentMethod: o.paymentMethod,
    platformPaymentMethod: o.platformPaymentMethod,
    externalOrderId: o.externalOrderId,
    recipientName: o.source === 'marketplace' && !o.customer ? (o.shippingAddress as StoredAddress)?.name || null : null,
    shipBy: isoOrNull(o.shipBy),
    total: toInt(o.total),
    lineCount: f.lineCount,
    totalQty: f.totalQty,
    itemsPreview: f.first && {
      productName: f.first.productName,
      attributesLabel: attributesOf(f.first, labels),
      thumbnailUrl: f.first.thumbnailUrl,
      quantity: f.first.quantity,
    },
    createdAt: o.createdAt.toISOString(),
    // Đơn sàn do sàn tạo; người lập đơn tay thêm cùng issue đơn tay (#105 A6).
    createdBy: null,
    version: o.version,
  };
}

/** Thông tin đơn cho `PackageSummary` của fulfillment (khách, SKU, tên sản phẩm, nhãn biến thể theo dòng đơn). */
export function packageOrderRef(o: OrderViewRow, lines: readonly OrderLineRow[], labels: Map<string, string>): PackageOrderRef {
  return {
    id: o.id,
    code: o.code,
    status: o.status,
    source: o.source,
    shopId: o.shopId,
    customerName: (o.shippingAddress as StoredAddress)?.name ?? o.customer?.name ?? null,
    paymentMethod: o.paymentMethod,
    cancelling: o.cancelling,
    platformCancelled: o.platformCancelled,
    lines: new Map(
      lines
        .filter((l) => l.orderId === o.id)
        .map((l) => [l.id, { sku: l.sku ?? l.externalSku ?? '', productName: l.productName, attributesLabel: attributesOf(l, labels) }]),
    ),
  };
}

const shopsOf = (ctx: SalesContext, ids: (string | null)[]) => {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))];
  return ctx.shopsOf && unique.length ? ctx.shopsOf(unique) : Promise.resolve(new Map<string, ShopRef>());
};

/** Lọc theo giai đoạn suy từ kiện hay cờ Sắp trễ hạn phải tính trong bộ nhớ: chỉ xét chừng này đơn chưa dừng mới nhất. */
const DERIVED_SCAN = 1000;

export async function listOrders(
  ctx: SalesContext,
  q: Omit<OrderFilter, 'flag' | 'openOnly'> & { page: number; pageSize: number; stage?: OrderStage | undefined; flag?: OrderFlag | undefined },
) {
  const now = Date.now();
  const offset = (q.page - 1) * q.pageSize;
  // Giai đoạn `completed`, `cancelled` chính là trạng thái; còn lại chỉ có ở đơn chưa dừng.
  const stageIsStatus = q.stage === 'completed' || q.stage === 'cancelled';
  const derived = q.flag === 'due_soon' || (q.stage !== undefined && !stageIsStatus);
  if (stageIsStatus && q.status && q.status !== q.stage) return { items: [], total: 0, page: q.page, pageSize: q.pageSize };
  const filter: OrderFilter = {
    ...q,
    status: stageIsStatus ? (q.stage as 'completed' | 'cancelled') : q.status,
    flag: q.flag === 'due_soon' ? undefined : q.flag,
    openOnly: derived,
  };

  const { rows, total } = derived ? await findOrderPage(filter, DERIVED_SCAN, 0) : await findOrderPage(filter, q.pageSize, offset);
  const facts = await factsOf(rows.map((r) => r.id));
  const [shops, labels] = await Promise.all([
    shopsOf(ctx, rows.map((r) => r.shopId)),
    variantLabels([...facts.values()].map((f) => (f.first && !f.first.attributesLabel ? f.first.variantId : null))),
  ]);
  const items = rows.map((r) => summary(r, facts.get(r.id)!, shops, labels, now));
  if (!derived) return { items, total, page: q.page, pageSize: q.pageSize };
  const matched = items.filter((s) => (!q.stage || s.display.stage === q.stage) && (q.flag !== 'due_soon' || s.flags.includes('due_soon')));
  return { items: matched.slice(offset, offset + q.pageSize), total: matched.length, page: q.page, pageSize: q.pageSize };
}

const notFound = () => new AppError(404, 'not_found', 'Không tìm thấy đơn');

export async function getOrder(ctx: SalesContext, id: string) {
  if (!isUuid(id)) throw notFound();
  const o = await findOrder(id);
  if (!o) throw notFound();
  const [facts, lines, shops, history] = await Promise.all([
    factsOf([id]),
    findOrderLines([id]),
    shopsOf(ctx, [o.shopId]),
    getStatusHistory('orders', id),
  ]);
  const f = facts.get(id)!;
  const labels = await variantLabels(lines.map((l) => l.variantId));
  const now = Date.now();
  const base = summary(o, f, shops, labels, now);
  const lastDelivered = f.packages.reduce<Date | null>((a, p) => (p.deliveredAt && (!a || p.deliveredAt > a) ? p.deliveredAt : a), null);
  const open = o.status === 'processing';
  const blocker = open
    ? completionBlocker({
        packages: f.packages.map((p) => p.status),
        lastDeliveredAt: isoOrNull(lastDelivered),
        openReturnRequests: f.openReturns,
        codUnconfirmed: false,
        now: Date.now(),
      })
    : null;
  const address = o.shippingAddress as StoredAddress;
  return {
    ...base,
    shippingAddress: address && {
      name: address.name,
      phone: address.phone,
      address: address.address,
      ward: address.ward ?? null,
      postCode: address.postCode ?? null,
    },
    subtotal: toInt(o.subtotal),
    shippingFee: toInt(o.shippingFee),
    shippingFeeOriginal: intOrNull(o.shippingFeeOriginal),
    shippingFeeDiscountSeller: intOrNull(o.shippingFeeDiscountSeller),
    shippingFeeDiscountPlatform: intOrNull(o.shippingFeeDiscountPlatform),
    note: '',
    buyerNote: o.buyerNote,
    cancelReason: o.cancelReason,
    invoiceNumber: o.invoiceNumber,
    lines: lines.map((l) => ({
      id: l.id,
      variantId: l.variantId,
      sku: l.sku ?? l.externalSku ?? '',
      productName: l.productName,
      attributesLabel: attributesOf(l, labels),
      quantity: l.quantity,
      unitPrice: toInt(l.unitPrice),
      lineTotal: toInt(l.lineTotal),
      externalSku: l.externalSku,
      thumbnailUrl: l.thumbnailUrl,
      externalSkuId: l.externalSkuId,
      externalShopSku: l.externalShopSku,
      externalProductId: l.externalProductId,
      paidPrice: intOrNull(l.paidPrice),
      taxAmount: intOrNull(l.taxAmount),
      cancelReason: l.cancelReason,
      cancelReasonDetail: l.cancelReasonDetail,
      cancelInitiator: l.cancelInitiator,
      cancelKind: l.cancelKind,
      reverseOrderId: l.reverseOrderId,
      returnStatus: l.returnStatus,
    })),
    packages: f.packages.map((p) => toPackageSummary(p, packageOrderRef(o, lines, labels), base.shop, now)),
    returnWindowEndsAt: lastDelivered ? new Date(lastDelivered.getTime() + RETURN_WINDOW_DAYS * 86_400_000).toISOString() : null,
    completionBlocker: blocker as 'packages_open' | 'return_window' | 'return_requested' | 'cod_unconfirmed' | null,
    statusHistory: history.map((h) => ({ ...h, at: h.at.toISOString() })),
  };
}
