// Cổng cho finance khi ghi hoàn tiền (#355, Documents/21 §11.3; 25 §10.1, E174): dòng trả của yêu cầu để finance tính
// doanh thu đã ghi của phần trả, và bật cờ Cần xử lý khi sàn báo hoàn tiền vượt mức đó. Finance gọi trong giao dịch
// ghi sổ của nó (consumer `sales.return_refunded`).
import { recordAudit } from '../../../core/index.ts';
import { findReturn, findReturnLines } from '../repository/returns.ts';
import { updateReturnShown } from './returns.ts';

export interface ReturnLineRef {
  orderLineId: string;
  /** Kiện chứa dòng; null khi dòng chưa gắn kiện (finance coi như chưa có doanh thu). */
  packageId: string | null;
  quantity: number;
  unitPrice: string;
}

/** Dòng trả của yêu cầu; yêu cầu không có hoặc khác công ty thì rỗng. */
export async function returnLinesOf(returnRequestId: string): Promise<ReturnLineRef[]> {
  const lines = await findReturnLines([returnRequestId]);
  return lines.map((l) => ({ orderLineId: l.orderLineId, packageId: l.packageId, quantity: l.quantity, unitPrice: l.unitPrice }));
}

/**
 * Bật Cần xử lý của yêu cầu kèm lý do, ghi nhật ký. Cờ đang bật vì việc khác thì nối lý do vào câu cũ (không xoá cờ của
 * luồng khác); lý do đã có trong câu thì bỏ (sự kiện giao lại). Trả true khi có ghi.
 */
export async function flagReturnForReview({ returnRequestId, reason }: { returnRequestId: string; reason: string }): Promise<boolean> {
  const row = await findReturn(returnRequestId, { lock: true });
  if (!row) return false;
  if (row.needsAttention && row.attentionNote?.includes(reason)) return false;
  const attentionNote = row.needsAttention && row.attentionNote ? `${row.attentionNote}. ${reason}` : reason;
  if (!(await updateReturnShown(row, { needsAttention: true, attentionNote }))) return false;
  await recordAudit({
    companyId: row.companyId,
    actorId: null,
    action: 'update',
    entityType: 'order.return_requests',
    entityId: row.id,
    label: row.code,
    before: { needsAttention: row.needsAttention, attentionNote: row.attentionNote },
    after: { needsAttention: true, attentionNote },
  });
  return true;
}
