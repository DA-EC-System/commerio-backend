// Phiếu nhận tác động lên đề nghị (spec #109 mục 6.5 bước 9, Q6): nhận một phần, nhận xong, tự Đã xử lý phiếu thiếu.
// Chạy trong giao dịch của bên gọi, sau khi đã khoá bản ghi đề nghị.
import { assertTransition, recordTransition } from '../../../core/index.ts';
import { outstanding } from '../domain/request.ts';
import { purchaseRequestMachine } from '../domain/request-machine.ts';
import { shortReceiptsOf, updateReceipt } from '../repository/receipts.ts';
import { findLines, type RequestRow, updateRequest } from '../repository/requests.ts';
import { RECEIPT_ENTITY } from './receipts.ts';
import { ENTITY } from './requests.ts';

/**
 * Sau khi cộng số nhận của một phiếu: hết còn chờ thì đề nghị sang Nhận xong và mọi phiếu thiếu tự Đã xử lý (giao bù
 * bằng phiếu vừa ghi); còn chờ thì sang Nhận một phần (chỉ ghi lịch sử khi đổi từ Đã đặt). Đề nghị đã Nhận xong từ phiếu
 * trước (phiếu này chỉ có thiếu hoặc trả tại chỗ) thì không chuyển nữa. Luôn tăng `version`.
 */
export async function applyReceiving(request: RequestRow, posted: { receiptId: string; actorId: string }): Promise<void> {
  const left = (await findLines([request.id])).reduce((s, l) => s + outstanding(l), 0);
  const action = left > 0 ? (request.status === 'ordered' ? 'receive_partial' : null) : request.status === 'received' ? null : 'receive_all';
  if (action) {
    const { to } = assertTransition(purchaseRequestMachine, request.status, action, { actor: null });
    await updateRequest(request.id, { status: to });
    await recordTransition({ entityType: ENTITY, entityId: request.id, from: request.status, to, action, actorId: null });
  } else {
    await updateRequest(request.id, {});
  }
  if (left === 0) await autoResolveShort(request.id, { kind: 'follow_up', followUpReceiptId: posted.receiptId, by: posted.actorId });
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
