// Cờ khiếu nại sàn của phiếu kiểm hàng hoàn (25 mục 9: hàng về thiếu, sai thì bật cờ Khiếu nại sàn). Gọi trong withCompany.
import { findDoc } from '../repository/documents.ts';

/** Phiếu kiểm hàng hoàn có phần thiếu (đi qua bước gửi duyệt); phiếu không thấy thì false. */
export async function returnInspectionClaimed(documentId: string): Promise<boolean> {
  const doc = await findDoc(documentId);
  return doc?.kind === 'return_inspection' && doc.claimFlag;
}
