// Báo sàn đã nhận hàng trả lỗi lúc quét (§20.1): yêu cầu mang cờ Cần xử lý với câu `CONFIRM_FAILED_NOTE`. Channel thử lại
// sau mỗi lượt kéo yêu cầu trả (`returnsAwaitingConfirm` → gọi sàn ngoài giao dịch → `markReturnConfirmed`); lần kéo thấy
// sàn đã qua bước chờ hàng về thì gỡ cờ (`syncExisting` trong `return-ingest.ts`). Cờ nhận ra theo đầu câu, như
// `UNKNOWN_STATUS_NOTE` của đơn: không thêm cột.
import { findReturn, findReturnLines, findReturnsAwaitingRefundApproval, findReturnsWithNote } from '../repository/returns.ts';
import { updateReturnShown } from './returns.ts';

export const CONFIRM_FAILED_NOTE = 'Chưa báo được sàn đã nhận hàng';

/** Câu cờ khi báo sàn lỗi; `message` là câu lỗi của app, bỏ dấu chấm cuối. */
export const confirmFailedNote = (message: string) =>
  `${CONFIRM_FAILED_NOTE}: ${message.replace(/[.\s]+$/, '')}. App tự thử lại mỗi lượt đồng bộ; cần gấp thì xác nhận đã nhận hàng trên Seller Center.`;

export const isConfirmFailedNote = (note: string | null) => note?.startsWith(CONFIRM_FAILED_NOTE) ?? false;

/** Tối đa mỗi lượt kéo của một gian hàng: lượt sau làm tiếp phần còn lại. */
const RETRY_BATCH = 20;

export interface ReturnToConfirm {
  id: string;
  externalReturnId: string;
  externalLineIds: string[];
}

/** Yêu cầu từ sàn của gian hàng đã quét nhận (`received`, `closed` nếu kiểm hàng hoàn đóng trước) mà chưa báo được sàn. */
export async function returnsAwaitingConfirm(shopId: string): Promise<ReturnToConfirm[]> {
  const rows = (await findReturnsWithNote(shopId, ['received', 'closed'], CONFIRM_FAILED_NOTE, RETRY_BATCH)).filter((r) => r.externalReturnId);
  if (!rows.length) return [];
  const lines = await findReturnLines(rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    externalReturnId: r.externalReturnId!,
    externalLineIds: lines.filter((l) => l.requestId === r.id && l.externalLineId).map((l) => l.externalLineId!),
  }));
}

/** Sàn đã nhận lần thử lại: gỡ cờ nếu cờ vẫn là cờ báo sàn (người khác đổi cờ thì giữ). */
export async function markReturnConfirmed(id: string): Promise<boolean> {
  const row = await findReturn(id, { lock: true });
  if (!row || !row.needsAttention || !isConfirmFailedNote(row.attentionNote)) return false;
  return updateReturnShown(row, { needsAttention: false, attentionNote: null });
}

// Đồng ý hoàn tiền sau kiểm hàng hoàn (#392; sàn có `approveReturnRefund`, TikTok `APPROVE_RECEIVED_PACKAGE`). Consumer
// đóng yêu cầu chạy trong giao dịch nên không gọi sàn: đánh `refund_approval = pending`, channel gọi sàn ngoài giao dịch
// trước mỗi lượt kéo yêu cầu trả (`returnsAwaitingRefundApproval` → `markRefundApproved` / `flagRefundApprovalFailed`).

export const REFUND_APPROVAL_FAILED_NOTE = 'Chưa báo được sàn đồng ý hoàn tiền';
export const REFUND_CLAIM_NOTE = 'Hàng trả về thiếu hoặc sai';

/** Câu cờ khi phiếu kiểm hàng hoàn có khiếu nại: app không báo sàn, người bán xử lý trên sàn. */
export const refundClaimNote = (inspectionNumber: string | null) =>
  `${REFUND_CLAIM_NOTE}${inspectionNumber ? ` (phiếu ${inspectionNumber})` : ''}: app không báo sàn đồng ý hoàn tiền. Từ chối nhận hàng hoặc khiếu nại trên Seller Center trước hạn của sàn.`;

/** Nối câu cờ cũ sau câu khiếu nại; gỡ câu khiếu nại thì trả lại câu cũ. */
const PREVIOUS_FLAG = ' Cờ trước: ';

/** Cờ khi phiếu có khiếu nại: câu khiếu nại đứng đầu (người bán phải làm trước hạn của sàn), câu cờ đang có giữ phía sau. */
export function claimFlag(row: { needsAttention: boolean; attentionNote: string | null }, inspectionNumber: string | null) {
  const previous = row.needsAttention && row.attentionNote ? `${PREVIOUS_FLAG}${row.attentionNote}` : '';
  return { needsAttention: true, attentionNote: `${refundClaimNote(inspectionNumber)}${previous}` };
}

/**
 * Sàn đã qua bước đồng ý hoàn tiền: gỡ cờ của bước này (báo lỗi, khiếu nại). Câu cờ cũ nối sau câu khiếu nại thì trả lại,
 * cờ vẫn bật. Không phải cờ của bước này thì null (không đổi).
 */
export function clearRefundApprovalFlag(row: { needsAttention: boolean; attentionNote: string | null }) {
  const note = row.attentionNote;
  if (!row.needsAttention || !note) return null;
  if (note.startsWith(REFUND_APPROVAL_FAILED_NOTE)) return { needsAttention: false, attentionNote: null };
  if (!note.startsWith(REFUND_CLAIM_NOTE)) return null;
  const at = note.indexOf(PREVIOUS_FLAG);
  return at < 0 ? { needsAttention: false, attentionNote: null } : { needsAttention: true, attentionNote: note.slice(at + PREVIOUS_FLAG.length) };
}

/** Yêu cầu đã đóng sau kiểm hàng hoàn của gian hàng, chờ báo sàn đồng ý hoàn tiền. */
export async function returnsAwaitingRefundApproval(shopId: string): Promise<ReturnToConfirm[]> {
  const rows = (await findReturnsAwaitingRefundApproval(shopId, RETRY_BATCH)).filter((r) => r.externalReturnId);
  return rows.map((r) => ({ id: r.id, externalReturnId: r.externalReturnId!, externalLineIds: [] }));
}

/** Sàn đã nhận lệnh: `done`, gỡ cờ báo lỗi của bước này nếu có. */
export async function markRefundApproved(id: string): Promise<boolean> {
  const row = await findReturn(id, { lock: true });
  if (!row || row.refundApproval !== 'pending') return false;
  const clear = row.needsAttention && row.attentionNote?.startsWith(REFUND_APPROVAL_FAILED_NOTE);
  return updateReturnShown(row, { refundApproval: 'done', ...(clear && { needsAttention: false, attentionNote: null }) });
}

/** Sàn lỗi: bật Cần xử lý một lần (cờ khác đang có thì giữ), giữ `pending` để lượt sau thử tiếp. */
export async function flagRefundApprovalFailed(id: string, message: string): Promise<boolean> {
  const row = await findReturn(id, { lock: true });
  if (!row || row.refundApproval !== 'pending' || row.needsAttention) return false;
  const note = `${REFUND_APPROVAL_FAILED_NOTE}: ${message.replace(/[.\s]+$/, '')}. App tự thử lại mỗi lượt đồng bộ; cần gấp thì đồng ý hoàn tiền trên Seller Center.`;
  return updateReturnShown(row, { needsAttention: true, attentionNote: note });
}
