// Thao tác đơn sàn như trên Seller Center (Documents/21 §19.3, #105 PR 2): lý do huỷ, người bán huỷ, trả lời khách xin
// huỷ, số hoá đơn. Gọi sàn ngoài giao dịch rồi mới ghi theo `version`. Huỷ trên sàn chỉ gắn cờ `cancelling`; đơn sang
// `cancelled` khi lần kéo sau thấy sàn báo huỷ (Thành chốt phương án a, 29/10/2026).
import { assertTransition, publishEvent, recordAudit } from '../../../core/index.ts';
import { isSealed } from '../../fulfillment/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { orderMachine, type OrderFlag } from '../domain/order.ts';
import { findOrder, findOrderLines } from '../repository/order-views.ts';
import { updateOrderAt } from '../repository/orders.ts';
import { getOrder, type SalesContext } from './orders.ts';

export interface Actor {
  accountId: string;
  companyId: string;
  permissions: readonly string[];
  enabledModules: readonly string[];
}

type OrderView = Awaited<ReturnType<typeof getOrder>>;

const marketplace = (ctx: SalesContext) => {
  if (!ctx.marketplaceOrders) throw new AppError(422, 'marketplace_unsupported', 'Chưa nối được sàn để thao tác đơn');
  return ctx.marketplaceOrders;
};

async function load(ctx: SalesContext, actor: Actor, id: string) {
  return withCompany(actor.companyId, async () => {
    const order = await getOrder(ctx, id);
    const [row, lines] = await Promise.all([findOrder(order.id), findOrderLines([order.id])]);
    return {
      order,
      shopId: row!.shopId,
      externalOrderId: row!.externalOrderId,
      lineIds: lines.flatMap((l) => (l.externalLineId ? [l.externalLineId] : [])),
    };
  });
}

const invalid = (order: OrderView) =>
  new AppError(409, 'invalid_transition', 'Thao tác không hợp lệ ở trạng thái hiện tại', { current: order });

function checkVersion(order: OrderView, version: number) {
  if (order.version !== version) throw new AppError(409, 'version_conflict', 'Đơn vừa được cập nhật, tải lại để xem', { current: order });
}

/** Ghi đơn theo `version` kèm nhật ký và sự kiện cờ, trong một giao dịch; trả bản chi tiết mới. */
async function save(
  ctx: SalesContext,
  actor: Actor,
  order: OrderView,
  patch: Parameters<typeof updateOrderAt>[2],
  audit: object,
  flags: OrderFlag[],
) {
  return withCompany(actor.companyId, async () => {
    if (!(await updateOrderAt(order.id, order.version, patch))) {
      throw new AppError(409, 'version_conflict', 'Đơn vừa được cập nhật, tải lại để xem', { current: await getOrder(ctx, order.id) });
    }
    await recordAudit({
      companyId: actor.companyId,
      actorId: actor.accountId,
      action: 'update',
      entityType: 'order.orders',
      entityId: order.id,
      before: { code: order.code, flags: order.flags },
      after: { code: order.code, ...audit },
    });
    await publishEvent({
      type: 'sales.order_status_changed',
      aggregateId: order.id,
      payload: { orderId: order.id, code: order.code, from: order.status, to: order.status, flags },
    });
    return getOrder(ctx, order.id);
  });
}

/** Gian hàng và mã đơn sàn; đơn không phải đơn sàn thì 422. */
function marketplaceRef(l: Awaited<ReturnType<typeof load>>) {
  if (l.order.source !== 'marketplace' || !l.shopId || !l.externalOrderId) {
    throw new AppError(422, 'not_allowed_for_source', 'Chỉ đơn sàn mới huỷ, trả lời yêu cầu huỷ trên sàn');
  }
  return { shopId: l.shopId, externalOrderId: l.externalOrderId };
}

export async function cancelReasons(ctx: SalesContext, actor: Actor, id: string) {
  const loaded = await load(ctx, actor, id);
  const { shopId, externalOrderId } = marketplaceRef(loaded);
  const { order, lineIds } = loaded;
  if ((order.status !== 'unpaid' && order.status !== 'processing') || order.flags.includes('cancelling')) throw invalid(order);
  return { items: await marketplace(ctx).cancelReasons(actor.companyId, shopId, externalOrderId, lineIds) };
}

export async function cancelOnPlatform(ctx: SalesContext, actor: Actor, id: string, input: { version: number; reasonId: string }) {
  const loaded = await load(ctx, actor, id);
  const { order, lineIds } = loaded;
  checkVersion(order, input.version);
  if (order.flags.includes('cancelling')) throw invalid(order);
  const packages = order.packages.map((p) => p.status);
  assertTransition(orderMachine, order.status, 'cancel_on_platform', {
    actor,
    record: { source: order.source, paymentMethod: order.paymentMethod, packages },
    view: order,
  });
  const { shopId, externalOrderId } = marketplaceRef(loaded);
  const port = marketplace(ctx);
  const reason = (await port.cancelReasons(actor.companyId, shopId, externalOrderId, lineIds)).find((r) => r.id === input.reasonId);
  if (!reason) {
    throw new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', { errors: { reasonId: 'Lý do không có trong danh sách sàn cho phép' } });
  }
  await port.cancel(actor.companyId, shopId, externalOrderId, lineIds, reason.id);
  const flags = [...order.flags.filter((f) => f !== 'cancel_requested'), 'cancelling' as const];
  const saved = await save(ctx, actor, order, { cancelling: true, cancelReason: reason.label }, { reasonId: reason.id, reason: reason.label, flags }, flags);
  return { order: saved, pendingOpen: packages.filter(isSealed).length };
}

export async function decideCancelRequest(ctx: SalesContext, actor: Actor, id: string, input: { version: number; decision: 'accept' | 'reject' }) {
  const loaded = await load(ctx, actor, id);
  const { order } = loaded;
  checkVersion(order, input.version);
  if (!order.flags.includes('cancel_requested')) throw invalid(order);
  const { shopId, externalOrderId } = marketplaceRef(loaded);
  const accept = input.decision === 'accept';
  await marketplace(ctx).decideCancel(actor.companyId, shopId, externalOrderId, accept);
  const flags = order.flags.filter((f) => f !== 'cancel_requested');
  if (accept) flags.push('cancelling');
  return save(ctx, actor, order, { cancelRequested: false, ...(accept ? { cancelling: true, cancelReason: 'Khách xin huỷ' } : {}) }, { decision: input.decision, flags }, flags);
}

export async function setInvoiceNumber(ctx: SalesContext, actor: Actor, id: string, input: { version: number; invoiceNumber: string }) {
  const { order } = await load(ctx, actor, id);
  checkVersion(order, input.version);
  return save(ctx, actor, order, { invoiceNumber: input.invoiceNumber }, { invoiceNumber: input.invoiceNumber }, order.flags);
}
