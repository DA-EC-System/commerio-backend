// Lập phiếu kho do hệ thống lập (phiếu xuất, phiếu đảo, phiếu kiểm hàng hoàn; spec #206 mục 5.3, Q18). Chạy trong giao
// dịch của bên gọi, sau khi đã khoá dòng tồn: dòng đếm `doc_counters` khoá sau cùng (thứ tự khoá ở mục 5.5).
import { recordTransition } from '../../../core/index.ts';
import { DOC_PREFIX, docNumber, type DocumentRef } from '../domain/documents.ts';
import { takeNextNumber } from '../repository/counters.ts';
import {
  type InsertedDocumentLine,
  insertDocument,
  insertDocumentLines,
  type NewDocumentLine,
  type NewSystemDocument,
} from '../repository/documents.ts';

export interface SystemDocumentInput extends Omit<NewSystemDocument, 'number'> {
  lines: readonly NewDocumentLine[];
  /** Lý do ghi vào lịch sử chuyển trạng thái (phiếu đảo). */
  reason?: string | null;
}

/** Cấp số theo loại phiếu, chèn phiếu và dòng, ghi lịch sử `null → status`. Trả số phiếu và các dòng vừa chèn. */
export async function createSystemDocument(input: SystemDocumentInput): Promise<{ ref: DocumentRef; lines: InsertedDocumentLine[] }> {
  const { lines, reason, ...doc } = input;
  const number = docNumber(DOC_PREFIX[doc.kind], await takeNextNumber(doc.kind));
  const documentId = await insertDocument({ ...doc, number });
  const inserted = await insertDocumentLines(documentId, lines);
  await recordTransition({
    entityType: 'stock_documents',
    entityId: documentId,
    from: null,
    to: doc.status,
    action: 'create',
    actorId: doc.actorId,
    reason: reason ?? null,
  });
  return { ref: { documentId, number }, lines: inserted };
}
