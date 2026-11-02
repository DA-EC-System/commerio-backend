// Xem đơn (Documents/21 §19.1): danh sách có giai đoạn, cờ suy ra; chi tiết kèm dòng, kiện, lịch sử.
import { Decimal } from 'decimal.js';
import { getStatusHistory } from '../../../core/index.ts';
import { getVariants } from '../../../product/index.ts';
import { findPackagesOfOrders, isHandedOver, type PackageStatus, type PackageViewRow } from '../../fulfillment/index.ts';
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

interface Facts {
  packages: PackageViewRow[];
  lineCount: number;
  unmapped: boolean;
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
        unmapped: lines.get(id)?.unmapped ?? false,
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

function summary(o: OrderViewRow, f: Facts, shops: Map<string, ShopRef>, now: number) {
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
    shipBy: isoOrNull(o.shipBy),
    total: toInt(o.total),
    lineCount: f.lineCount,
    createdAt: o.createdAt.toISOString(),
    // Đơn sàn do sàn tạo; người lập đơn tay thêm cùng issue đơn tay (#105 A6).
    createdBy: null,
    version: o.version,
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
  const shops = await shopsOf(ctx, rows.map((r) => r.shopId));
  const items = rows.map((r) => summary(r, facts.get(r.id)!, shops, now));
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
  const variants = new Map(
    (await getVariants(lines.flatMap((l) => (l.variantId ? [l.variantId] : [])))).map((v) => [v.id, v]),
  );
  const label = (variantId: string | null) => (variantId ? (variants.get(variantId)?.attributes.map((a) => a.value).join(' / ') ?? '') : '');
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const base = summary(o, f, shops, Date.now());
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
  const address = o.shippingAddress as { name: string; phone: string; address: string } | null;
  return {
    ...base,
    shippingAddress: address,
    subtotal: toInt(o.subtotal),
    shippingFee: toInt(o.shippingFee),
    note: '',
    cancelReason: o.cancelReason,
    invoiceNumber: o.invoiceNumber,
    lines: lines.map((l) => ({
      id: l.id,
      variantId: l.variantId,
      sku: l.sku ?? l.externalSku ?? '',
      productName: l.productName,
      attributesLabel: label(l.variantId),
      quantity: l.quantity,
      unitPrice: toInt(l.unitPrice),
      lineTotal: toInt(l.lineTotal),
      externalSku: l.externalSku,
    })),
    packages: f.packages.map((p) => {
      const pkgLines = p.lines.map((pl) => {
        const l = lineById.get(pl.orderLineId);
        return {
          variantId: pl.variantId,
          sku: l?.sku ?? l?.externalSku ?? '',
          productName: l?.productName ?? '',
          attributesLabel: label(pl.variantId),
          quantity: pl.quantity,
        };
      });
      return {
        id: p.id,
        code: p.code,
        order: { id: o.id, code: o.code, status: o.status },
        source: o.source,
        shop: base.shop,
        customerName: address?.name ?? o.customer?.name ?? null,
        status: p.status as PackageStatus,
        flags: [
          ...(p.needsOpen ? (['needs_open'] as const) : []),
          ...(p.needsAttention ? (['needs_attention'] as const) : []),
          ...(p.lostReportedBy && p.status !== 'lost' ? (['lost_reported'] as const) : []),
        ],
        flagNote: p.flagNote,
        openPurpose: p.openPurpose,
        selfDelivery: p.selfDelivery,
        paymentMethod: o.paymentMethod,
        paymentStatus: null,
        trackingCode: p.trackingCode,
        platformPackageCode: p.platformPackageCode,
        carrier: null,
        shipBy: isoOrNull(p.shipBy),
        lines: pkgLines,
        totalQty: pkgLines.reduce((a, l) => a + l.quantity, 0),
        handedOverAt: isHandedOver(p.status) ? isoOrNull(p.handedOverAt) : null,
        deliveredAt: isoOrNull(p.deliveredAt),
        deliveredBy: null,
        lostReport: null,
        createdAt: p.createdAt.toISOString(),
        version: p.version,
      };
    }),
    returnWindowEndsAt: lastDelivered ? new Date(lastDelivered.getTime() + RETURN_WINDOW_DAYS * 86_400_000).toISOString() : null,
    completionBlocker: blocker as 'packages_open' | 'return_window' | 'return_requested' | 'cod_unconfirmed' | null,
    statusHistory: history.map((h) => ({ ...h, at: h.at.toISOString() })),
  };
}
