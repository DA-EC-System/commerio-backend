// Báo sàn đã nhận hàng trả lỗi lúc quét (§20.1): yêu cầu mang cờ Cần xử lý với câu `CONFIRM_FAILED_NOTE`. Channel thử lại
// sau mỗi lượt kéo yêu cầu trả (`returnsAwaitingConfirm` → gọi sàn ngoài giao dịch → `markReturnConfirmed`); lần kéo thấy
// sàn đã qua bước chờ hàng về thì gỡ cờ (`syncExisting` trong `return-ingest.ts`). Cờ nhận ra theo đầu câu, như
// `UNKNOWN_STATUS_NOTE` của đơn: không thêm cột.
import { findReturn, findReturnLines, findReturnsWithNote } from '../repository/returns.ts';
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
