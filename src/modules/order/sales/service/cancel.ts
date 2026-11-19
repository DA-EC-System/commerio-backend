// Thao tác đơn sàn như trên Seller Center (Documents/21 §19.3, #105 PR 2): lý do huỷ, người bán huỷ, trả lời khách xin
// huỷ, số hoá đơn. Gọi sàn ngoài giao dịch rồi mới ghi theo `version`. Huỷ trên sàn chỉ ghi `cancel_pending` (API: cờ
// `cancelling`); đơn sang `cancelled` khi lần kéo sau thấy sàn báo huỷ (Thành chốt phương án a, 29/10/2026).
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
    // Món chưa huỷ hết: phần Sale còn huỷ được. Gửi cả món sàn đã huỷ thì TikTok báo không hợp lệ (`cancelEligibility`).
    const open = lines.filter((l) => l.cancelledQty < l.quantity);
    // Món khách đang xin huỷ (sàn chép người, lý do lên món); món đã huỷ trước giữ lý do cũ nên không tính. Món khách xin
    // trả hàng, hoàn tiền (Lazada `return-customer`) cũng ghi người là khách nhưng không phải xin huỷ: bỏ.
    const requested = open.filter((l) => l.cancelInitiator === 'buyer' && (l.cancelKind === null || l.cancelKind === 'cancellation'));
    return {
      order,
      shopId: row!.shopId,
      externalOrderId: row!.externalOrderId,
      lineIds: open.flatMap((l) => (l.externalLineId ? [l.externalLineId] : [])),
      // Lý do khách ghi khi xin huỷ, cho lý do huỷ cả đơn khi Sale đồng ý (DH-B06).
      buyerReason: requested.find((l) => l.cancelReason)?.cancelReason ?? null,
      // Khách xin huỷ chỉ một phần món (Lazada huỷ theo món): đồng ý là huỷ dòng (25 §8.3), không phải huỷ cả đơn. Sàn
      // không ghi món nào thì coi như cả đơn (TikTok VN chỉ huỷ cả đơn).
      partialRequest: requested.length > 0 && requested.length < open.length,
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
      label: order.code,
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

/**
 * Đơn Đang huỷ (cờ suy ra: lệnh huỷ cả đơn chờ sàn, hay sàn đã huỷ cả đơn mà còn kiện chờ mở) không gửi huỷ lần nữa.
 * Huỷ một phần món không bật cờ này nên Sale vẫn huỷ được phần còn lại.
 */
const cancelling = (order: OrderView) => order.flags.includes('cancelling');

/** Mọi món đã huỷ (đơn chờ lượt khép lại): không gửi lên sàn lệnh huỷ không có món nào, báo rõ cho Sale. */
function assertLinesLeft(order: OrderView, lineIds: readonly string[]) {
  if (!lineIds.length) {
    throw new AppError(409, 'invalid_transition', 'Đơn không còn món nào để huỷ: mọi món đã được huỷ trên sàn', { current: order });
  }
}

export async function cancelReasons(ctx: SalesContext, actor: Actor, id: string) {
  const loaded = await load(ctx, actor, id);
  const { shopId, externalOrderId } = marketplaceRef(loaded);
  const { order, lineIds } = loaded;
  if ((order.status !== 'unpaid' && order.status !== 'processing') || cancelling(order)) throw invalid(order);
  assertLinesLeft(order, lineIds);
  return { items: await marketplace(ctx).cancelReasons(actor.companyId, shopId, externalOrderId, lineIds) };
}

export async function cancelOnPlatform(ctx: SalesContext, actor: Actor, id: string, input: { version: number; reasonId: string }) {
  const loaded = await load(ctx, actor, id);
  const { order, lineIds } = loaded;
  checkVersion(order, input.version);
  if (cancelling(order)) throw invalid(order);
  assertLinesLeft(order, lineIds);
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
  // Huỷ cả đơn (mọi món chưa huỷ): ghi lý do Sale chọn; sàn xác nhận huỷ không ghi đè (DH-B06).
  const saved = await save(
    ctx,
    actor,
    order,
    { cancelPending: true, cancelRequested: false, cancelReason: reason.label },
    { reasonId: reason.id, reason: reason.label, flags },
    flags,
  );
  return { order: saved, pendingOpen: packages.filter(isSealed).length };
}

/** Lý do từ chối yêu cầu huỷ do sàn quy định (#227): chỉ khi đơn có cờ `cancel_requested`; sàn không có danh sách thì rỗng. */
export async function cancelRejectReasons(ctx: SalesContext, actor: Actor, id: string) {
  const loaded = await load(ctx, actor, id);
  const { shopId, externalOrderId } = marketplaceRef(loaded);
  if (!loaded.order.flags.includes('cancel_requested')) throw invalid(loaded.order);
  const reasons = await marketplace(ctx).cancelRejectReasons(actor.companyId, shopId, externalOrderId);
  return { items: reasons.map((r) => ({ id: r.id, label: r.label })) };
}

export async function decideCancelRequest(
  ctx: SalesContext,
  actor: Actor,
  id: string,
  input: { version: number; decision: 'accept' | 'reject'; rejectReasonId?: string },
) {
  const loaded = await load(ctx, actor, id);
  const { order } = loaded;
  checkVersion(order, input.version);
  if (!order.flags.includes('cancel_requested')) throw invalid(order);
  const { shopId, externalOrderId } = marketplaceRef(loaded);
  const accept = input.decision === 'accept';
  // Sàn bắt buộc lý do từ chối (TikTok) mà thiếu thì channel trả 422 `errors.rejectReasonId`; sàn không cần thì bỏ qua (#227).
  const rejectReasonId = accept ? undefined : input.rejectReasonId;
  await marketplace(ctx).decideCancel(actor.companyId, shopId, externalOrderId, accept, rejectReasonId);
  // Đồng ý yêu cầu huỷ cả đơn đi như Sale huỷ (21 §19.3): chờ sàn huỷ mọi món, lý do của khách trên sàn (không có thì
  // "Khách xin huỷ"; DH-B06). Yêu cầu chỉ một phần món là huỷ dòng: không cờ Đang huỷ, không lý do cấp đơn. Người huỷ
  // nằm ở dòng (sàn ghi khi huỷ).
  const wholeOrder = accept && !loaded.partialRequest;
  const flags = order.flags.filter((f) => f !== 'cancel_requested');
  if (wholeOrder && !flags.includes('cancelling')) flags.push('cancelling');
  return save(
    ctx,
    actor,
    order,
    { cancelRequested: false, ...(wholeOrder ? { cancelPending: true, cancelReason: loaded.buyerReason ?? 'Khách xin huỷ' } : {}) },
    { decision: input.decision, ...(rejectReasonId ? { rejectReasonId } : {}), flags },
    flags,
  );
}

export async function setInvoiceNumber(ctx: SalesContext, actor: Actor, id: string, input: { version: number; invoiceNumber: string }) {
  const { order } = await load(ctx, actor, id);
  checkVersion(order, input.version);
  return save(ctx, actor, order, { invoiceNumber: input.invoiceNumber }, { invoiceNumber: input.invoiceNumber }, order.flags);
}
