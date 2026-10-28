// Sổ tiền theo đơn (#116; Documents/21 §21.1, §11.2; 25 §10.1, §10.2, §10.4). Module tiền chỉ nghe sự kiện: các hàm
// `record…` nhận payload của sự kiện (fulfillment, sales, inventory) và ghi dòng ước tính, mỗi nguồn một lần. Loại sự
// kiện chưa có trong danh mục (#106, #107, #112 thêm), nên chưa đăng ký consumer: test gọi thẳng hàm.
import { withCompany } from '../../../../shared/db/client.ts';
import { addDays, vnDate } from '../domain/config-version.ts';
import { type Draft, postDelivered, postInspected, postRefund, postReturned, profitOf, taxWarnings } from '../domain/ledger.ts';
import {
  entriesOfOrder,
  findEntries,
  insertEntries,
  type LedgerFilter,
  type LedgerRow,
  type LedgerSource,
  ledgerTotals,
  lockSource,
  revenueSince,
  sourcePosted,
} from '../repository/ledger.ts';
import { getEffectiveConfig } from './config-versions.ts';
import { isUuid, notFound, type Orders, ordersOf } from './views.ts';

export interface PackageDelivered {
  packageId: string;
  orderId: string;
  shopId: string;
  deliveredAt: string;
  lines: { variantId: string; quantity: number; unitPrice: string; unitCost: string }[];
  platformSubsidy: string;
  shippingIncome: string;
  shippingCost: string;
}
export interface PackageReturned {
  packageId: string;
  orderId: string;
  shopId: string;
  returnedAt: string;
}
export interface ReturnRefunded {
  returnRequestId: string;
  orderId: string;
  shopId: string;
  refundAmount: string;
  refundedAt: string;
}
export interface ReturnInspected {
  inspectionId: string;
  orderId: string;
  shopId: string;
  inspectedAt: string;
  lines: { variantId: string; resellable: number; unitCost: string }[];
}

interface Target {
  source: { type: LedgerSource; id: string };
  orderId: string;
  shopId: string;
  packageId?: string;
  returnRequestId?: string;
  occurredOn: string;
}

/** Ghi các dòng ước tính của một nguồn; nguồn đã ghi thì bỏ qua (sự kiện giao ít nhất một lần). Trả số dòng đã ghi. */
async function post(companyId: string, t: Target, drafts: Draft[]): Promise<number> {
  await lockSource(t.source.type, t.source.id);
  if (await sourcePosted(t.source.type, t.source.id)) return 0;
  await insertEntries(
    drafts.map((d) => ({
      companyId,
      kind: d.kind,
      amount: d.amount,
      isEstimate: true,
      occurredOn: t.occurredOn,
      orderId: t.orderId,
      packageId: t.packageId ?? null,
      returnRequestId: t.returnRequestId ?? null,
      shopId: t.shopId,
      sourceType: t.source.type,
      sourceId: t.source.id,
      configVersionId: d.configVersionId,
    })),
  );
  return drafts.length;
}

const dayOf = (iso: string) => vnDate(new Date(iso));

/** `fulfillment.package_delivered`: doanh thu, trợ giá, ship, phí, thuế khấu trừ, giá vốn theo phiên bản tại ngày giao. */
export function recordPackageDelivered(companyId: string, e: PackageDelivered): Promise<number> {
  return withCompany(companyId, async () => {
    const day = dayOf(e.deliveredAt);
    const configs = {
      fee: await getEffectiveConfig('fee', e.shopId, day),
      regime: await getEffectiveConfig('tax_regime', null, day),
      rules: await getEffectiveConfig('tax_rules', null, day),
    };
    const target = { source: { type: 'package' as const, id: e.packageId }, orderId: e.orderId, shopId: e.shopId, packageId: e.packageId };
    return post(companyId, { ...target, occurredOn: day }, postDelivered(e, configs));
  });
}

/** `fulfillment.package_returned`: phí khi hoàn theo cấu hình phí của gian hàng tại ngày hoàn. */
export function recordPackageReturned(companyId: string, e: PackageReturned): Promise<number> {
  return withCompany(companyId, async () => {
    const day = dayOf(e.returnedAt);
    const drafts = postReturned(await getEffectiveConfig('fee', e.shopId, day));
    const target = { source: { type: 'package_return' as const, id: e.packageId }, orderId: e.orderId, shopId: e.shopId, packageId: e.packageId };
    return post(companyId, { ...target, occurredOn: day }, drafts);
  });
}

/** `sales.return_refunded`: tiền hoàn cho khách. */
export function recordReturnRefunded(companyId: string, e: ReturnRefunded): Promise<number> {
  return withCompany(companyId, () =>
    post(
      companyId,
      {
        source: { type: 'return_refund', id: e.returnRequestId },
        orderId: e.orderId,
        shopId: e.shopId,
        returnRequestId: e.returnRequestId,
        occurredOn: dayOf(e.refundedAt),
      },
      postRefund(e.refundAmount),
    ),
  );
}

/** `inventory.return_inspected`: giảm giá vốn phần hàng trả bán lại được. */
export function recordReturnInspected(companyId: string, e: ReturnInspected): Promise<number> {
  return withCompany(companyId, () =>
    post(
      companyId,
      { source: { type: 'return_inspection', id: e.inspectionId }, orderId: e.orderId, shopId: e.shopId, occurredOn: dayOf(e.inspectedAt) },
      postInspected(e.lines),
    ),
  );
}

/** `LedgerLine` của §21.1. `txnId`, `bankMatch` có khi đối soát (#117). */
function lineView(r: LedgerRow, orders: Orders) {
  return {
    id: r.id,
    kind: r.kind,
    amount: Number(r.amount),
    estimated: r.isEstimate,
    replacesId: r.replacesEntryId,
    replacedBy: r.replacedBy,
    occurredOn: r.occurredOn,
    shopId: r.shopId,
    orderId: r.orderId,
    orderCode: (r.orderId && orders.get(r.orderId)?.code) ?? null,
    packageId: r.packageId,
    returnRequestId: r.returnRequestId,
    configVersionId: r.configVersionId,
    txnId: null,
    source: r.sourceType && r.sourceId ? { type: r.sourceType, id: r.sourceId } : null,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
    bankMatch: null,
  };
}

export interface LedgerQuery extends Omit<LedgerFilter, 'hideCost'> {
  page: number;
  pageSize: number;
}

/** `GET /finance/ledger`: trang sổ kèm tổng theo chỗ tiền. Không có quyền xem giá vốn thì bỏ dòng giá vốn (R4). */
export function listLedger(companyId: string, q: LedgerQuery, canSeeCost: boolean) {
  return withCompany(companyId, async () => {
    const filter = { ...q, to: q.to && addDays(q.to, 1), hideCost: !canSeeCost };
    const { rows, total } = await findEntries(filter, { limit: q.pageSize, offset: (q.page - 1) * q.pageSize });
    const orders = await ordersOf(rows.map((r) => r.orderId));
    const sums = await ledgerTotals(q.shopId);
    return {
      items: rows.map((r) => lineView(r, orders)),
      total,
      page: q.page,
      pageSize: q.pageSize,
      // Rút tiền (#117) và tiền mua hàng đã cam kết (purchasing) chưa nối: `withdrawn` 0, `committedPurchase` null.
      totals: { receivable: Number(sums.receivable), platformBalance: Number(sums.platformBalance), withdrawn: 0, committedPurchase: null },
    };
  });
}

/** `GET /finance/orders/:orderId/profit` (25 §10.2): chỉ tính phần đã giao. Không có quyền xem giá vốn thì `cogs`, `gross` null. */
export function orderProfit(companyId: string, orderId: string, canSeeCost: boolean) {
  return withCompany(companyId, async () => {
    if (!isUuid(orderId)) throw notFound('đơn');
    const rows = await entriesOfOrder(orderId);
    const orders = await ordersOf([orderId]);
    if (!rows.length && !orders.has(orderId)) throw notFound('đơn');
    const p = profitOf(rows.map((r) => ({ kind: r.kind, amount: r.amount, isEstimate: r.isEstimate, replaced: r.replacedBy !== null })));
    const visible = canSeeCost ? rows : rows.filter((r) => r.kind !== 'cogs' && r.kind !== 'cogs_reversal');
    return {
      net: p.net,
      cogs: canSeeCost ? p.cogs : null,
      gross: canSeeCost ? p.gross : null,
      estimated: p.estimated,
      lines: visible.map((r) => lineView(r, orders)),
    };
  });
}

/** `GET /finance/tax-warnings` (25 §10.4): luỹ kế doanh thu năm so với mốc của quy tắc thuế đang áp, cảnh báo từ 90%. */
export function getTaxWarnings(companyId: string, now = new Date()) {
  return withCompany(companyId, async () => {
    const today = vnDate(now);
    const regime = await getEffectiveConfig('tax_regime', null, today);
    const rules = await getEffectiveConfig('tax_rules', null, today);
    const ytd = Number(await revenueSince(`${today.slice(0, 4)}-01-01`));
    return { regime: regime?.payload.regime ?? null, items: rules ? taxWarnings(ytd, rules.payload.milestones) : [] };
  });
}
