// Yêu cầu trả từ sàn (#202, Documents/25 §9, Documents/21 §20.1): channel kéo về rồi gọi `ingestMarketplaceReturn` trong
// `withCompany`; kiểm hàng hoàn xong (`inventory.return_inspected`) thì đóng yêu cầu. Sàn là nguồn của trạng thái yêu cầu
// trước khi hàng về; app là nguồn của nhận hàng (quét) và kiểm hàng.
import { requireCompanyId } from '../../../../shared/db/client.ts';
import { deliverForReturn, packageLinesOfOrderLines } from '../../fulfillment/index.ts';
import {
  changedFields,
  distributeResell,
  RETURN_PLATFORM_SHOWN_FIELDS,
  refundAmountOf,
  type ReturnStatus,
  syncAction,
  syncTarget,
  weightedUnitCost,
} from '../domain/return.ts';
import { lockMarketplaceOrder, takeNextNumber, updateOrder } from '../repository/orders.ts';
import {
  findMarketplaceReturn,
  findReturnByInspection,
  findReturnLines,
  insertReturn,
  insertReturnLines,
  orderLinesByExternal,
  type ReturnPatch,
  type ReturnRow,
  updateReturnLine,
} from '../repository/returns.ts';
import { returnInspectionClaimed } from '../../../product/index.ts';
import type { MarketplaceReturns } from './marketplace-returns.ts';
import { claimFlag, clearRefundApprovalFlag, isConfirmFailedNote } from './return-confirm.ts';
import { applyReturnStep, publishReturnStatusChanged, updateReturnShown } from './returns.ts';

/** Yêu cầu trả của sàn đã chuẩn hoá (channel đổi từ `RemoteReturn`). Tiền là chuỗi thập phân. */
export interface PlatformReturn {
  shopId: string;
  externalReturnId: string;
  externalOrderId: string;
  /** `replacement` (đổi hàng) chưa có luồng: bỏ qua. */
  kind: 'return' | 'refund' | 'replacement';
  /** Trạng thái app ứng với trạng thái sàn; null khi sàn trả giá trị app chưa hiểu (chỉ cập nhật thông tin sàn). */
  status: ReturnStatus | null;
  rawStatus: string;
  ofcStatus: string | null;
  disputeInProgress: boolean;
  returnTo: 'warehouse' | 'merchant' | null;
  returnTrackingCode: string | null;
  reason: string | null;
  refundAmount: string | null;
  /** Hạn người bán phải trả lời, null khi sàn không chờ người bán (#392). */
  respondBy?: Date | null;
  /** Sàn báo người bán đã xử lý hàng về (`syncAction`, #392); thiếu là false. */
  sellerHandledReceipt?: boolean;
  lines: { externalLineId: string; externalReturnLineId: string | null; quantity: number }[];
  updatedAt: Date;
}

export type ReturnIngestOutcome = 'created' | 'updated' | 'unchanged' | 'unknown_order' | 'skipped';

const pad = (n: number) => String(n).padStart(6, '0');

/** Thông tin sàn chép mỗi lần kéo (R11, chỉ để hiện). */
function platformFields(r: PlatformReturn): ReturnPatch {
  return {
    rawMarketplaceStatus: r.rawStatus,
    ofcStatus: r.ofcStatus,
    disputeInProgress: r.disputeInProgress,
    returnTo: r.returnTo,
    returnTrackingCode: r.returnTrackingCode,
    respondBy: r.respondBy ?? null,
    externalUpdatedAt: r.updatedAt,
    ...(r.refundAmount !== null && { refundAmount: r.refundAmount }),
  };
}

/**
 * Tạo hoặc cập nhật yêu cầu trả theo (gian hàng, mã yêu cầu sàn). Đơn chưa có trong app thì bỏ (`unknown_order`): mốc kéo
 * vẫn tiến nên yêu cầu đó chỉ về lại khi sàn sửa nó lần nữa (đơn đặt trước mốc kéo đơn thì không bao giờ có trong app).
 * Gọi trong `withCompany` (một giao dịch).
 */
export async function ingestMarketplaceReturn(r: PlatformReturn): Promise<ReturnIngestOutcome> {
  if (r.kind === 'replacement') return 'skipped';
  const existing = await findMarketplaceReturn(r.shopId, r.externalReturnId);
  if (existing) return syncExisting(existing, r);
  const order = await lockMarketplaceOrder(r.shopId, r.externalOrderId);
  if (!order) return 'unknown_order';
  const row = await createRequest(order.id, r);
  if (!row) {
    // Lần kéo khác vừa tạo cùng yêu cầu: khoá đọc lại rồi đi như cập nhật.
    return syncExisting((await findMarketplaceReturn(r.shopId, r.externalReturnId))!, r);
  }
  // Tạo ở `requested` rồi đi theo máy trạng thái tới trạng thái sàn: lịch sử, sự kiện tiền như một lần chuyển thường.
  if (r.status && r.status !== 'requested') await syncExisting(row, r);
  return 'created';
}

async function createRequest(orderId: string, r: PlatformReturn): Promise<ReturnRow | undefined> {
  const orderLines = await orderLinesByExternal(orderId, r.lines.map((l) => l.externalLineId));
  const byExternal = new Map(orderLines.map((l) => [l.externalLineId!, l]));
  // Gộp các món về dòng đơn (Lazada mỗi món một dòng số lượng 1); mã dòng đơn ngược lấy món đầu.
  const lines = new Map<string, { orderLine: (typeof orderLines)[number]; quantity: number; externalReturnLineId: string | null }>();
  const missing: string[] = [];
  for (const l of r.lines) {
    const orderLine = byExternal.get(l.externalLineId);
    if (!orderLine) {
      missing.push(l.externalLineId);
      continue;
    }
    const line = lines.get(orderLine.id) ?? { orderLine, quantity: 0, externalReturnLineId: l.externalReturnLineId };
    line.quantity += l.quantity;
    lines.set(orderLine.id, line);
  }
  const pkgLines = await packageLinesOfOrderLines([...lines.keys()]);
  const notes: string[] = [];
  if (missing.length) notes.push(`Sàn có món không khớp dòng đơn: ${missing.join(', ')}`);
  // Khách trả hàng thì kiện phải đã giao: mọi kiện chứa dòng trả còn trên đường nhảy tới `delivered` (25 §9); khác thì
  // người dùng đối chiếu. Làm trước khi tính giá vốn để kiện vừa nhảy cóc được tính là đã giao.
  const jumped = new Set<string>();
  let held = false;
  if (r.kind === 'return') {
    for (const packageId of new Set(pkgLines.map((p) => p.packageId))) {
      const outcome = await deliverForReturn(packageId, 'Sàn mở yêu cầu trả khi kiện chưa giao xong');
      if (outcome === 'jumped') jumped.add(packageId);
      if (outcome === 'held') held = true;
      if (outcome !== 'delivered') notes.push(`Kiện của dòng trả ở trạng thái ${outcome === 'jumped' ? 'chưa giao, đã chuyển sang Đã giao' : outcome}`);
    }
  }
  const rows = [...lines.values()].map((l) => {
    const own = pkgLines
      .filter((p) => p.orderLineId === l.orderLine.id)
      .map((p) => ({ ...p, status: jumped.has(p.packageId) ? ('delivered' as const) : p.status }));
    // Giá vốn bình quân chỉ trên dòng kiện đã giao (25 §9); kiện hoàn, thất lạc, chưa giao không tính.
    const delivered = own.filter((p) => p.status === 'delivered');
    // Một dòng trả gắn một kiện: kiện đã giao đầu tiên, không có thì kiện đầu (để đối chiếu).
    const pkg = delivered[0] ?? own[0];
    return {
      orderLineId: l.orderLine.id,
      packageId: pkg?.packageId ?? null,
      variantId: l.orderLine.variantId,
      quantity: l.quantity,
      unitPrice: l.orderLine.unitPrice,
      unitCost: weightedUnitCost(delivered),
      externalLineId: l.externalReturnLineId,
      // Mọi kiện của dòng đã hoàn về kho (E109).
      packageReturned: own.length > 0 && own.every((p) => p.status === 'returned'),
    };
  });

  const created = await insertReturn({
    companyId: requireCompanyId('ingestMarketplaceReturn'),
    code: `YCT-${pad(await takeNextNumber('return_request'))}`,
    orderId,
    source: 'marketplace',
    shopId: r.shopId,
    externalReturnId: r.externalReturnId,
    status: 'requested',
    kind: r.kind === 'refund' ? 'refund' : 'return',
    reason: r.reason ?? '',
    refundAmount: r.refundAmount ?? refundAmountOf(rows),
    needsAttention: notes.length > 0,
    attentionNote: notes.length ? notes.join('. ') : null,
    ...platformFields(r),
  });
  if (!created) return undefined;
  await publishReturnStatusChanged(created, null, created.status);
  await insertReturnLines(rows.map((l) => ({ ...l, companyId: created.companyId, requestId: created.id })));
  // Kiện đang hoàn, thất lạc (hoặc chưa rời kho): cả đơn bật Cần xử lý để đối chiếu với sàn (25 §9). Đơn đã khoá ở trên.
  if (held) await updateOrder(orderId, { needsAttention: true, attentionNote: `Yêu cầu trả ${created.code}: kiện chưa ở trạng thái đã giao, đối chiếu với sàn` });
  return created;
}

/** Trạng thái sàn sau bước chờ hàng về: sàn đã ghi nhận hàng tới người bán. */
const PAST_AWAITING: readonly ReturnStatus[] = ['received', 'refund_only', 'closed'];

/** Đầu câu cờ khi sàn báo trạng thái app không đi tới được; lượt sau sàn khớp lại thì gỡ (nhận theo đầu câu, không thêm cột). */
export const CONFLICT_NOTE = 'Sàn báo ';
const isConflictNote = (note: string | null) => note?.startsWith(CONFLICT_NOTE) ?? false;

/** Đưa yêu cầu tới trạng thái sàn báo nếu máy trạng thái cho phép; không cho thì bật Cần xử lý, giữ trạng thái app. */
async function syncExisting(row: ReturnRow, r: PlatformReturn): Promise<ReturnIngestOutcome> {
  const stale = row.externalUpdatedAt !== null && r.updatedAt.getTime() < row.externalUpdatedAt.getTime();
  if (stale) return 'unchanged';
  const fields = platformFields(r);
  // Sàn đã qua bước chờ hàng về (lần thử lại báo sàn vừa xong, hay người bán xác nhận trên Seller Center): gỡ cờ báo sàn.
  if (row.needsAttention && isConfirmFailedNote(row.attentionNote) && r.status && PAST_AWAITING.includes(r.status)) {
    Object.assign(fields, { needsAttention: false, attentionNote: null });
  }
  // Sàn đã qua bước đồng ý hoàn tiền (lần báo của app vừa xong, hay người bán làm trên Seller Center, sàn tự hoàn):
  // không còn gì phải báo, gỡ cờ báo lỗi của bước này.
  if (r.sellerHandledReceipt === true && (row.refundApproval === 'pending' || row.refundApproval === 'withheld')) {
    Object.assign(fields, { refundApproval: 'done' });
    Object.assign(fields, clearRefundApprovalFlag(row));
  }
  const action = r.status ? syncAction(row.status, r.status, row.closeResult, r.sellerHandledReceipt ?? false) : null;
  if (action === 'conflict') {
    // Cờ báo sàn đã nhận còn đó thì giữ câu của nó: lượt thử lại tìm yêu cầu theo đầu câu này (`returnsAwaitingConfirm`).
    const keep = row.needsAttention && isConfirmFailedNote(row.attentionNote) && !('attentionNote' in fields);
    const note = keep ? row.attentionNote : `${CONFLICT_NOTE}${r.rawStatus} nhưng yêu cầu đang ${row.status}`;
    const diff = changedFields(row, { ...fields, needsAttention: true, attentionNote: note });
    if (!Object.keys(diff).length) return 'unchanged';
    await updateReturnShown(row, diff);
    return 'updated';
  }
  // Sàn đã khớp lại với app: gỡ cờ mâu thuẫn của lượt trước. Cờ của luồng khác giữ nguyên.
  if (row.needsAttention && isConflictNote(row.attentionNote)) Object.assign(fields, { needsAttention: false, attentionNote: null });
  if (action) {
    await applyReturnStep(
      row,
      { action, to: syncTarget(r.status!), actorId: null, source: 'marketplace', reason: action === 'reject' ? (r.reason ?? r.rawStatus) : null },
      fields,
    );
    return 'updated';
  }
  const diff = changedFields(row, fields);
  if (!Object.keys(diff).length) return 'unchanged';
  await updateReturnShown(row, diff);
  return RETURN_PLATFORM_SHOWN_FIELDS.some((k) => k in diff) ? 'updated' : 'unchanged';
}

/**
 * `inventory.return_inspected` (§11.2): phiếu kiểm hàng hoàn của yêu cầu đã ghi sổ thì đóng yêu cầu (`close`,
 * `inspected`), chia số bán lại về dòng, tính `resellCost`, hoàn tiền (`sales.return_refunded` trong `applyReturnStep`).
 * Phiếu không thuộc yêu cầu nào (kiện hoàn, kiện không khớp) thì bỏ qua.
 */
export async function onReturnInspected(
  event: { payload: { inspectionId: string; lines: readonly { variantId: string; resellable: number }[] } },
  ctx?: { marketplaceReturns?: MarketplaceReturns },
): Promise<void> {
  const row = await findReturnByInspection(event.payload.inspectionId);
  if (!row || row.status !== 'received') return;
  const lines = await findReturnLines([row.id]);
  const resellable = new Map<string, number>();
  for (const l of event.payload.lines) resellable.set(l.variantId, (resellable.get(l.variantId) ?? 0) + l.resellable);
  const { perLine, resellCost } = distributeResell(lines, resellable);
  for (const l of lines) await updateReturnLine(l.id, { resellQty: perLine.get(l.id) ?? 0 });
  await applyReturnStep(row, { action: 'close', to: 'closed', actorId: null, source: 'system' }, { resellCost, ...(await refundApprovalOf(row, event.payload.inspectionId, ctx)) });
}

/**
 * Sàn có bước đồng ý hoàn tiền sau kiểm hàng (#392, TikTok): phiếu không khiếu nại thì chờ channel báo sàn (`pending`); có
 * khiếu nại (hàng về thiếu, sai) thì không báo, bật Cần xử lý để người bán từ chối nhận hàng hay khiếu nại trên sàn (25 mục 9).
 */
async function refundApprovalOf(row: ReturnRow, inspectionId: string, ctx?: { marketplaceReturns?: MarketplaceReturns }): Promise<ReturnPatch> {
  if (row.source !== 'marketplace' || !row.shopId || !ctx?.marketplaceReturns) return {};
  if (!(await ctx.marketplaceReturns.approvesRefundAfterInspection(row.companyId, row.shopId))) return {};
  if (!(await returnInspectionClaimed(inspectionId))) return { refundApproval: 'pending' };
  return { refundApproval: 'withheld', ...claimFlag(row, row.inspectionNumber) };
}
