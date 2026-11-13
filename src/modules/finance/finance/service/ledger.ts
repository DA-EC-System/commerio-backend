// Sổ tiền theo đơn (#116; Documents/21 §21.1, §11.2; 25 §10.1, §10.2, §10.4). Module tiền chỉ nghe sự kiện: các hàm
// `record…` nhận payload của sự kiện (fulfillment, sales, inventory, purchasing) và ghi dòng, mỗi nguồn một lần.
// Consumer `finance-ledger` (`registerLedgerConsumers`, #228) gọi chúng trong giao dịch của khung sự kiện.
import { type EventEnvelope, type EventPayload, type EventType, registerConsumer } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { addDays, outputVatPctOf, vnDate } from '../domain/config-version.ts';
import {
  costMissingOf,
  type Draft,
  postDelivered,
  postInspected,
  postRefund,
  postReturned,
  postSupplierRefund,
  profitOf,
  taxWarnings,
} from '../domain/ledger.ts';
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
import { bankMatchesOf } from '../repository/ledger.ts';
import { findOrderSettlement } from '../repository/order-settlements.ts';
import { getEffectiveConfig } from './config-versions.ts';
import { markDelivered } from './order-settlement-state.ts';
import { isUuid, notFound, type Orders, ordersOf, userRef } from './views.ts';

// Payload theo danh mục sự kiện (Documents/21 §11.2).
export type PackageDelivered = EventPayload<'fulfillment.package_delivered'>;
export type PackageReturned = EventPayload<'fulfillment.package_returned'>;
export type ReturnRefunded = EventPayload<'sales.return_refunded'>;
export type ReturnInspected = EventPayload<'inventory.return_inspected'>;
export type SupplierReturnRefunded = EventPayload<'purchasing.supplier_return_refunded'>;

interface Target {
  source: { type: LedgerSource; id: string };
  orderId: string | null;
  shopId: string | null;
  packageId?: string;
  returnRequestId?: string;
  occurredOn: string;
  /** Mặc định ước tính; tiền NCC hoàn là số thực tế (chờ khớp sao kê). */
  isEstimate?: boolean;
}

/** Ghi các dòng của một nguồn; nguồn đã ghi thì bỏ qua (sự kiện giao ít nhất một lần). Trả số dòng đã ghi. */
async function post(companyId: string, t: Target, drafts: Draft[]): Promise<number> {
  await lockSource(t.source.type, t.source.id);
  if (await sourcePosted(t.source.type, t.source.id)) return 0;
  await insertEntries(
    drafts.map((d) => ({
      companyId,
      kind: d.kind,
      amount: d.amount,
      isEstimate: t.isEstimate ?? true,
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
    const written = await post(companyId, { ...target, occurredOn: day }, postDelivered(e, configs));
    // Trạng thái tiền của đơn (#117): kiện đầu tiên giao xong thì `none → pending`, cập nhật tổng ước tính; dòng không
    // có giá vốn thì đánh dấu đơn thiếu giá vốn (#229).
    if (written) await markDelivered(e.orderId, e.shopId, costMissingOf(e.lines));
    return written;
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

/** `purchasing.supplier_return_refunded`: dòng thực tế `supplier_refund`, không gắn đơn, gian hàng, chờ khớp sao kê. */
export function recordSupplierReturnRefunded(companyId: string, e: SupplierReturnRefunded): Promise<number> {
  return withCompany(companyId, () =>
    post(
      companyId,
      { source: { type: 'supplier_return', id: e.supplierReturnId }, orderId: null, shopId: null, occurredOn: dayOf(e.recordedAt), isEstimate: false },
      postSupplierRefund(e.refundAmount),
    ),
  );
}

export const LEDGER_CONSUMER = 'finance-ledger';

type Recorder<T extends EventType> = (companyId: string, payload: EventPayload<T>) => Promise<number>;
const on =
  <T extends EventType>(record: Recorder<T>) =>
  async (e: EventEnvelope<T, EventPayload<T>>) => {
    await record(e.companyId!, e.payload);
  };

/**
 * Handler của consumer `finance-ledger` theo loại sự kiện (21 §11.2). Khung chạy handler trong `withCompany` của sự
 * kiện và ghi `processed_events` (consumer, eventId) cùng giao dịch; khoá nguồn chặn thêm trường hợp cùng nguồn khác
 * `eventId`. `sales.order_cancelled` không nghe: đơn huỷ không phát sinh khoản nào (25 §10.1), phạt chỉ có từ quyết toán.
 */
export const ledgerHandlers = {
  'fulfillment.package_delivered': on<'fulfillment.package_delivered'>(recordPackageDelivered),
  'fulfillment.package_returned': on<'fulfillment.package_returned'>(recordPackageReturned),
  'sales.return_refunded': on<'sales.return_refunded'>(recordReturnRefunded),
  'inventory.return_inspected': on<'inventory.return_inspected'>(recordReturnInspected),
  'purchasing.supplier_return_refunded': on<'purchasing.supplier_return_refunded'>(recordSupplierReturnRefunded),
};

/** Đăng ký mọi loại của consumer `finance-ledger` trong một khối đồng bộ (worker, `startFinanceBackground`). */
export function registerLedgerConsumers(): void {
  const options = { consumer: LEDGER_CONSUMER };
  registerConsumer('fulfillment.package_delivered', ledgerHandlers['fulfillment.package_delivered'], options);
  registerConsumer('fulfillment.package_returned', ledgerHandlers['fulfillment.package_returned'], options);
  registerConsumer('sales.return_refunded', ledgerHandlers['sales.return_refunded'], options);
  registerConsumer('inventory.return_inspected', ledgerHandlers['inventory.return_inspected'], options);
  registerConsumer('purchasing.supplier_return_refunded', ledgerHandlers['purchasing.supplier_return_refunded'], options);
}

type Names = Map<string, Promise<{ id: string; name: string } | null>>;

/** `LedgerLine` của §21.1 cho một trang: kèm mã đơn, lần khớp sao kê và tên người khớp (#117). */
export async function lineViews(rows: readonly LedgerRow[], orders?: Orders) {
  const byOrder = orders ?? (await ordersOf(rows.map((r) => r.orderId)));
  const matches = await bankMatchesOf(rows.map((r) => r.id));
  const names: Names = new Map();
  return Promise.all(
    rows.map(async (r) => {
      const m = matches.get(r.id);
      const by = m && (await userRef(m.matchedBy, names));
      return { ...lineView(r, byOrder), bankMatch: m && by ? { bankRef: m.bankRef, by, at: m.matchedAt.toISOString() } : null };
    }),
  );
}

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
    txnId: r.externalTransactionId,
    externalOrderId: r.externalOrderId,
    flags: r.externalOrderId && !r.orderId ? (['unknown_order'] as const) : ([] as const),
    source: r.sourceType && r.sourceId ? { type: r.sourceType, id: r.sourceId } : null,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
    bankMatch: null as { bankRef: string; by: { id: string; name: string }; at: string } | null,
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
    const sums = await ledgerTotals(q.shopId);
    return {
      items: await lineViews(rows),
      total,
      page: q.page,
      pageSize: q.pageSize,
      // Tiền mua hàng đã cam kết (đề nghị nhập đã duyệt chưa trả NCC) cần cổng của purchasing: chưa nối, `null`.
      totals: {
        receivable: Number(sums.receivable),
        platformBalance: Number(sums.platformBalance),
        withdrawn: Number(sums.withdrawn),
        committedPurchase: null,
      },
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
    // Đơn đã có số thật (#117): số thật của cả đơn thay mọi dòng ước tính, kể cả khoản sàn không thu.
    const settled = rows.some((r) => !r.isEstimate);
    const vat = await outputVatByDay(rows.filter((r) => r.kind === 'revenue' || r.kind === 'customer_refund').map((r) => r.occurredOn));
    const p = profitOf(
      rows.map((r) => ({
        kind: r.kind,
        amount: r.amount,
        isEstimate: r.isEstimate,
        replaced: r.replacedBy !== null || (r.isEstimate && settled),
        outputVatPct: vat.get(r.occurredOn) ?? 0,
      })),
    );
    const visible = canSeeCost ? rows : rows.filter((r) => r.kind !== 'cogs' && r.kind !== 'cogs_reversal');
    return {
      net: p.net,
      cogs: canSeeCost ? p.cogs : null,
      gross: canSeeCost ? p.gross : null,
      estimated: p.estimated,
      costMissing: (await findOrderSettlement(orderId))?.costMissing ?? false,
      lines: await lineViews(visible, orders),
    };
  });
}

/**
 * Thuế suất GTGT đầu ra áp ở từng ngày (25 §10.2, §10.4: chọn phiên bản loại hình, quy tắc thuế theo ngày phát sinh).
 * Gọi trong `withCompany` của bên gọi. Phiên bản hồi tố đã áp dụng thì lãi đọc lại theo bản mới, không cần dòng sổ.
 */
async function outputVatByDay(days: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const day of new Set(days)) {
    const regime = await getEffectiveConfig('tax_regime', null, day);
    const rules = await getEffectiveConfig('tax_rules', null, day);
    out.set(day, outputVatPctOf(regime?.payload, rules?.payload));
  }
  return out;
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
