// Phiếu nhận tác động lên đề nghị (spec #109 mục 6.5 bước 9, 6.6, Q6): nhận một phần, nhận xong, đóng thiếu, tự Đã xử lý
// phiếu thiếu. Chạy trong giao dịch của bên gọi, sau khi đã khoá bản ghi đề nghị.
import { assertTransition, recordTransition } from '../../../core/index.ts';
import { outstanding } from '../domain/request.ts';
import { purchaseRequestMachine } from '../domain/request-machine.ts';
import { shortReceiptsOf, updateReceipt } from '../repository/receipts.ts';
import { findLines, type LineRow, receiptsOf, type RequestRow, updateLine, updateRequest } from '../repository/requests.ts';
import { RECEIPT_ENTITY } from './receipts.ts';
import { type Actor, toDetail } from './request-views.ts';
import { ENTITY } from './requests.ts';
import { checkTransition } from './transitions.ts';

/**
 * Sau khi cộng số nhận của một phiếu: hết còn chờ thì đề nghị sang Nhận xong và mọi phiếu thiếu tự Đã xử lý (giao bù
 * bằng phiếu vừa ghi); còn chờ thì sang Nhận một phần (chỉ ghi lịch sử khi đổi từ Đã đặt). Luôn tăng `version`.
 */
export async function applyReceiving(request: RequestRow, posted: { receiptId: string; actorId: string }): Promise<void> {
  const left = (await findLines([request.id])).reduce((s, l) => s + outstanding(l), 0);
  const action = left === 0 ? 'receive_all' : request.status === 'ordered' ? 'receive_partial' : null;
  if (!action) {
    await updateRequest(request.id, {});
    return;
  }
  const { to } = assertTransition(purchaseRequestMachine, request.status, action, { actor: null });
  await updateRequest(request.id, { status: to });
  await recordTransition({ entityType: ENTITY, entityId: request.id, from: request.status, to, action, actorId: null });
  if (to === 'received') {
    await autoResolveShort(request.id, { kind: 'follow_up', followUpReceiptId: posted.receiptId, by: posted.actorId });
  }
}

export type AutoResolution =
  | { kind: 'follow_up'; followUpReceiptId: string; by: string }
  | { kind: 'close_short'; note: string; by: string };

/**
 * Mọi phiếu Giao thiếu của đề nghị sang Đã xử lý (spec #109 Q6). `by` là người gây ra (người ghi sổ phiếu bù hoặc CEO
 * đóng thiếu); lịch sử ghi nguồn hệ thống.
 */
export async function autoResolveShort(requestId: string, r: AutoResolution): Promise<void> {
  for (const receipt of await shortReceiptsOf(requestId)) {
    await updateReceipt(receipt.id, {
      status: 'resolved',
      shortResolution: r.kind,
      followUpReceiptId: r.kind === 'follow_up' ? r.followUpReceiptId : null,
      resolutionNote: r.kind === 'close_short' ? r.note : null,
      resolvedBy: r.by,
      resolvedAt: new Date(),
    });
    await recordTransition({ entityType: RECEIPT_ENTITY, entityId: receipt.id, from: 'short', to: 'resolved', action: 'auto_resolve', actorId: null });
  }
}

/** Phần còn chờ của mỗi dòng chuyển sang đã đóng thiếu, đang về giảm đúng phần đó (Documents/25 §3.2). */
async function closeShortLines(lines: readonly LineRow[]): Promise<void> {
  for (const l of lines) {
    const left = outstanding(l);
    if (left > 0) await updateLine(l.id, { closedShortQty: l.closedShortQty + left });
  }
}

/**
 * Đóng thiếu đề nghị: đường duy nhất, dùng cho thao tác `close_short` của đề nghị và kết quả giao thiếu `close_short`
 * của phiếu nhận. Còn phiếu đang kiểm thì 409 `receipt_counting`; mọi phiếu Giao thiếu tự sang Đã xử lý (spec #109 Q6).
 */
export async function closeShortRequest(actor: Actor, request: RequestRow, reason: string | null): Promise<void> {
  const lines = await findLines([request.id]);
  const receipts = (await receiptsOf([request.id])).filter((r) => r.status !== 'cancelled');
  const record = {
    createdBy: request.createdBy,
    lineCount: lines.length,
    activeLines: lines.filter((l) => !l.excluded).length,
    receiptCount: receipts.length,
    countingReceipts: receipts.filter((r) => r.status === 'counting').length,
  };
  const { to } = await checkTransition(purchaseRequestMachine, request.status, 'close_short', { actor, record, reason }, () =>
    toDetail(request, actor),
  );
  await closeShortLines(lines);
  await updateRequest(request.id, { status: to, closedBy: actor.accountId, closedAt: new Date(), statusReason: reason });
  await recordTransition({ entityType: ENTITY, entityId: request.id, from: request.status, to, action: 'close_short', actorId: actor.accountId, reason });
  await autoResolveShort(request.id, { kind: 'close_short', note: reason!, by: actor.accountId });
}
