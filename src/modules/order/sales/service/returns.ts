// Yêu cầu trả: xem và thao tác (Documents/21 §20, §20.1; 25 §9). Thao tác trên yêu cầu từ sàn gọi sàn ngoài giao dịch
// (qua `ctx.marketplaceReturns` do channel tiêm) rồi mới ghi theo `version`, như huỷ đơn sàn (`cancel.ts`).
import { Decimal } from 'decimal.js';
import { assertTransition, findAccountSummaries, getStatusHistory, publishEvent, recordAudit, recordTransition } from '../../../core/index.ts';
import { countOpenUnmatchedParcels } from '../../fulfillment/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import {
  CLOSE_RESULT,
  REFUNDING_ACTIONS,
  RETURN_STATUSES,
  type ReturnAction,
  returnMachine,
  type ReturnStatus,
} from '../domain/return.ts';
import {
  findReturn,
  findReturnLines,
  findReturnOrder,
  findReturnPage,
  type ReturnFilter,
  type ReturnPatch,
  type ReturnRow,
  updateReturnAt,
} from '../repository/returns.ts';
import type { Actor } from './cancel.ts';
import type { SalesContext } from './orders.ts';

const toInt = (money: string | null) => (money === null ? null : new Decimal(money).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber());

export const notFound = () => new AppError(404, 'not_found', 'Không tìm thấy yêu cầu trả');

const COST_PERMISSION = 'inventory.cost.view';

export interface ViewOptions {
  canViewCost: boolean;
}

/** Bản chi tiết `ReturnRequest` (§20, §20.1). Chạy trong `withCompany`. */
export async function returnView(ctx: SalesContext, row: ReturnRow, opts: ViewOptions) {
  const [order, lines, statusHistory, people] = await Promise.all([
    findReturnOrder(row.orderId),
    findReturnLines([row.id]),
    getStatusHistory('return_requests', row.id),
    findAccountSummaries(row.receivedBy ? [row.receivedBy] : []),
  ]);
  const shop = row.shopId ? (await ctx.shopsOf?.([row.shopId]))?.get(row.shopId) : undefined;
  const resellQty = lines.some((l) => l.resellQty !== null) ? lines.reduce((n, l) => n + (l.resellQty ?? 0), 0) : null;
  return {
    id: row.id,
    code: row.code,
    order: { id: row.orderId, code: order!.code },
    source: row.source,
    kind: row.kind,
    shopId: row.shopId,
    shopName: shop?.shopName ?? null,
    customerName: order!.customerName,
    status: row.status,
    closeResult: row.closeResult,
    rawMarketplaceStatus: row.rawMarketplaceStatus,
    totalQty: lines.reduce((n, l) => n + l.quantity, 0),
    refundAmount: toInt(row.refundAmount)!,
    createdAt: row.createdAt.toISOString(),
    version: row.version,
    reason: row.reason,
    lines: lines.map((l) => ({
      variantId: l.variantId,
      sku: l.sku,
      productName: l.productName,
      attributesLabel: l.attributesLabel ?? '',
      quantity: l.quantity,
      unitPrice: toInt(l.unitPrice)!,
      packageId: l.packageId,
      packageCode: l.packageCode,
    })),
    returnTrackingCode: row.returnTrackingCode,
    inspection: row.inspectionId ? { type: 'stock_document' as const, id: row.inspectionId, number: row.inspectionNumber ?? '' } : null,
    receivedAt: row.receivedAt?.toISOString() ?? null,
    receivedBy: row.receivedBy ? { id: row.receivedBy, name: people[0]?.fullName ?? '' } : null,
    money: {
      refundAmount: toInt(row.refundAmount)!,
      refunded: row.refunded,
      resellQty,
      resellCost: opts.canViewCost ? toInt(row.resellCost) : null,
    },
    needsAttention: row.needsAttention,
    attentionNote: row.attentionNote,
    statusHistory,
    platform:
      row.source === 'marketplace'
        ? {
            reverseStatus: row.rawMarketplaceStatus ?? '',
            ofcStatus: row.ofcStatus,
            disputeInProgress: row.disputeInProgress,
            returnTo: row.returnTo as 'warehouse' | 'merchant' | null,
          }
        : null,
    rejectReason: row.rejectReasonId ? { id: row.rejectReasonId, label: row.rejectReasonLabel ?? '' } : null,
    attachments: [],
  };
}

export type ReturnView = Awaited<ReturnType<typeof returnView>>;

export const canViewCost = (actor: Pick<Actor, 'permissions'>) => actor.permissions.includes(COST_PERMISSION);

export async function getReturn(ctx: SalesContext, actor: Actor, id: string): Promise<ReturnView> {
  return withCompany(actor.companyId, async () => {
    const row = isUuid(id) ? await findReturn(id) : undefined;
    if (!row) throw notFound();
    return returnView(ctx, row, { canViewCost: canViewCost(actor) });
  });
}

export async function listReturns(ctx: SalesContext, companyId: string, q: ReturnFilter & { page: number; pageSize: number }) {
  return withCompany(companyId, async () => {
    const [{ items, total, byStatus }, unmatched] = await Promise.all([findReturnPage(q, q.page, q.pageSize), countOpenUnmatchedParcels()]);
    const shopIds = [...new Set(items.flatMap((r) => (r.shopId ? [r.shopId] : [])))];
    const shops = shopIds.length && ctx.shopsOf ? await ctx.shopsOf(shopIds) : new Map();
    const counts = Object.fromEntries(RETURN_STATUSES.map((s) => [s, byStatus.get(s) ?? 0])) as Record<ReturnStatus, number>;
    return {
      items: items.map((r) => ({
        id: r.id,
        code: r.code,
        order: { id: r.orderId, code: r.orderCode },
        source: r.source,
        kind: r.kind,
        shopId: r.shopId,
        shopName: r.shopId ? (shops.get(r.shopId)?.shopName ?? null) : null,
        customerName: r.customerName,
        status: r.status,
        closeResult: r.closeResult,
        rawMarketplaceStatus: r.rawMarketplaceStatus,
        totalQty: r.totalQty,
        refundAmount: toInt(r.refundAmount)!,
        createdAt: r.createdAt.toISOString(),
        version: r.version,
      })),
      total,
      page: q.page,
      pageSize: q.pageSize,
      counts: { ...counts, unmatched },
    };
  });
}

/**
 * Ghi một bước của máy trạng thái trong giao dịch hiện tại: UPDATE theo `version` + trạng thái, lịch sử, nhật ký,
 * `sales.return_refunded` khi bước hoàn tiền cho khách. `actorId` null là sàn hoặc hệ thống. Trả false khi bản ghi vừa đổi.
 */
export async function applyReturnStep(
  row: ReturnRow,
  step: { action: ReturnAction; to: ReturnStatus; actorId: string | null; reason?: string | null; source?: 'user' | 'system' | 'marketplace' },
  patch: ReturnPatch = {},
): Promise<boolean> {
  const closeResult = CLOSE_RESULT[step.action];
  const refunds = REFUNDING_ACTIONS.includes(step.action) && !row.refunded;
  const now = new Date();
  const full: ReturnPatch = {
    status: step.to,
    ...(closeResult && { closeResult }),
    ...(refunds && { refunded: true, refundedAt: now }),
    ...(step.action === 'reject' && step.reason && { statusReason: step.reason }),
    ...(step.action === 'no_show' && step.reason && { statusReason: step.reason }),
    ...patch,
  };
  if (!(await updateReturnAt(row.id, row.version, row.status, full))) return false;
  await recordTransition({
    entityType: 'return_requests',
    entityId: row.id,
    from: row.status,
    to: step.to,
    action: step.action,
    actorId: step.actorId,
    source: step.source ?? (step.actorId ? 'user' : 'system'),
    reason: step.reason ?? null,
  });
  if (step.actorId) {
    await recordAudit({
      companyId: row.companyId,
      actorId: step.actorId,
      action: 'update',
      entityType: 'order.return_requests',
      entityId: row.id,
      before: { code: row.code, status: row.status },
      after: { code: row.code, status: step.to, action: step.action, ...(step.reason && { reason: step.reason }) },
    });
  }
  if (refunds) {
    // `return_refunded.shopId` không null (Documents/21 §11.2, #308): yêu cầu trả chỉ tạo từ sàn (`ingestMarketplaceReturn`,
    // CHECK `return_requests_marketplace_ref`), sổ tiền ghi hoàn tiền khách theo gian hàng.
    if (!row.shopId) throw new Error(`Yêu cầu trả ${row.code} thiếu gian hàng`);
    await publishEvent({
      type: 'sales.return_refunded',
      aggregateId: row.orderId,
      payload: {
        returnRequestId: row.id,
        orderId: row.orderId,
        shopId: row.shopId,
        refundAmount: patch.refundAmount ?? row.refundAmount,
        refundedAt: now.toISOString(),
      },
    });
  }
  Object.assign(row, full, { version: row.version + 1 });
  return true;
}

/** Thao tác người dùng ở `POST /returns/:id/:action`. */
export type UserReturnAction = 'accept' | 'reject' | 'refund_only' | 'platform_reopen' | 'platform_refund' | 'no_show';

export interface ActionInput {
  version: number;
  reason?: string | undefined;
  reasonId?: string | undefined;
  comment?: string | undefined;
  attachmentIds?: string[] | undefined;
}

const marketplaceOf = (ctx: SalesContext) => {
  if (!ctx.marketplaceReturns) throw new AppError(422, 'marketplace_unsupported', 'Chưa nối được sàn để xử lý yêu cầu trả');
  return ctx.marketplaceReturns;
};

const conflict = (current: ReturnView) => new AppError(409, 'version_conflict', 'Yêu cầu trả vừa được cập nhật, tải lại để xem', { current });

/** Bước cần báo sàn: người bán quyết trên sàn trước (§20.1). Ghi nhận sàn xử, khách không gửi hàng chỉ ghi ở app. */
const SENDS: Partial<Record<UserReturnAction, 'accept' | 'reject' | 'refund'>> = { accept: 'accept', reject: 'reject', refund_only: 'refund' };

export async function actOnReturn(ctx: SalesContext, actor: Actor, id: string, action: UserReturnAction, input: ActionInput): Promise<ReturnView> {
  const opts = { canViewCost: canViewCost(actor) };
  const loaded = await withCompany(actor.companyId, async () => {
    const row = isUuid(id) ? await findReturn(id) : undefined;
    if (!row) throw notFound();
    return { row, view: await returnView(ctx, row, opts), lines: await findReturnLines([row.id]) };
  });
  const { row, view } = loaded;
  if (row.version !== input.version) throw conflict(view);
  const marketplace = row.source === 'marketplace';
  // Đơn sàn: từ chối theo lý do của sàn (`reasonId`), lý do chữ là câu hiển thị của lý do đó.
  let reason = input.reason?.trim() || null;
  let rejectReason: { id: string; label: string } | null = null;
  const send = marketplace ? SENDS[action] : undefined;
  if (marketplace && action === 'reject') {
    if (!input.reasonId) throw invalidField('reasonId', 'Chọn lý do từ chối của sàn');
    // Yêu cầu chỉ hoàn tiền: từ chối là từ chối hoàn tiền, theo danh sách lý do của bước đó (§20.1 `refuse-refund`).
    const reasonAction = row.kind === 'refund' ? 'refuse-refund' : 'reject';
    const found = (await marketplaceOf(ctx).reasons(actor.companyId, row.shopId!, row.externalReturnId!, reasonAction)).find((r) => r.id === input.reasonId);
    if (!found) throw invalidField('reasonId', 'Lý do không có trong danh sách sàn cho phép');
    if (found.requiresImage && !input.attachmentIds?.length) throw invalidField('attachmentIds', 'Lý do này cần ảnh minh chứng');
    rejectReason = { id: found.id, label: found.label };
    reason = reason ?? found.label;
  }
  const { to } = assertTransition(returnMachine, row.status, action, { actor, record: { source: row.source, kind: row.kind }, reason, view });
  if (send) {
    const externalLineIds = loaded.lines.flatMap((l) => (l.externalLineId ? [l.externalLineId] : []));
    await marketplaceOf(ctx).decide(actor.companyId, row.shopId!, row.externalReturnId!, externalLineIds, send, {
      ...(rejectReason && { reasonId: rejectReason.id }),
      ...(input.comment && { comment: input.comment }),
      kind: row.kind,
    });
  }
  return withCompany(actor.companyId, async () => {
    const fresh = (await findReturn(row.id, { lock: true }))!;
    if (fresh.version !== row.version) throw conflict(await returnView(ctx, fresh, opts));
    const patch: ReturnPatch = rejectReason ? { rejectReasonId: rejectReason.id, rejectReasonLabel: rejectReason.label } : {};
    if (!(await applyReturnStep(fresh, { action, to, actorId: actor.accountId, reason }, patch))) {
      throw conflict(await returnView(ctx, (await findReturn(row.id))!, opts));
    }
    return returnView(ctx, fresh, opts);
  });
}

export function invalidField(field: string, message: string): AppError {
  return new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', { errors: { [field]: message } });
}

/** Yêu cầu từ sàn: trả `{ shopId, externalReturnId }`, yêu cầu tạo tay thì 422 `not_marketplace` (§20.1). */
async function marketplaceRef(actor: Actor, id: string) {
  const found = await withCompany(actor.companyId, async () => {
    const row = isUuid(id) ? await findReturn(id) : undefined;
    return row && { row, lines: await findReturnLines([row.id]) };
  });
  if (!found) throw notFound();
  const { row, lines } = found;
  if (row.source !== 'marketplace' || !row.shopId || !row.externalReturnId) {
    throw new AppError(422, 'not_marketplace', 'Chỉ yêu cầu trả từ sàn mới có thao tác này');
  }
  return { shopId: row.shopId, externalReturnId: row.externalReturnId, lineIds: lines.flatMap((l) => (l.externalLineId ? [l.externalLineId] : [])) };
}

export async function returnReasons(ctx: SalesContext, actor: Actor, id: string, action: 'reject' | 'refuse-refund') {
  const ref = await marketplaceRef(actor, id);
  return { items: await marketplaceOf(ctx).reasons(actor.companyId, ref.shopId, ref.externalReturnId, action) };
}

export async function platformHistory(ctx: SalesContext, actor: Actor, id: string) {
  const ref = await marketplaceRef(actor, id);
  const items = await marketplaceOf(ctx).history(actor.companyId, ref.shopId, ref.externalReturnId, ref.lineIds);
  return { items: [...items].sort((a, b) => b.at.localeCompare(a.at)) };
}
