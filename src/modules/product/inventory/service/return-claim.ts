// Phiếu kiểm hàng hoàn có vấn đề (25 mục 9: hàng về thiếu, sai thì bật cờ Khiếu nại sàn). Sales dùng để không tự báo sàn
// đồng ý hoàn tiền (commerio-backend#392, #437). Gọi trong withCompany.
import { findDoc, linesOfDocs } from '../repository/documents.ts';

/**
 * Phiếu kiểm hàng hoàn có dòng thiếu (đi qua bước gửi duyệt phần thiếu, hay quét ít hơn dự kiến), sai mẫu (dòng ngoài
 * yêu cầu: dự kiến 0, quét từ 1) hoặc hỏng (`damaged_qty > 0`); phiếu không thấy thì false. Trả NCC không tính: dòng phiếu không ghi
 * lý do trả NCC, nên app không biết phần đó có phải do hỏng (Thành chốt 24/11/2026, #437).
 */
export async function returnInspectionClaimed(documentId: string): Promise<boolean> {
  const doc = await findDoc(documentId);
  if (doc?.kind !== 'return_inspection') return false;
  if (doc.claimFlag) return true;
  const lines = (await linesOfDocs([documentId])).get(documentId) ?? [];
  return lines.some(
    (l) =>
      (l.damagedQty ?? 0) > 0 ||
      ((l.expectedQty ?? 0) === 0 && (l.scannedQty ?? 0) > 0) ||
      (l.expectedQty !== null && l.scannedQty !== null && l.scannedQty < l.expectedQty),
  );
}
