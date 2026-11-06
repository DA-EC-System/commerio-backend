// Hàng quay về kho theo kiện hoàn hoặc yêu cầu trả (Documents/21 mục 11.1, 15.3; spec #206 mục 5.5, Q19). Chạy trong
// giao dịch của bên gọi. Chỉ lập phiếu kiểm hàng hoàn nháp: tồn, giá vốn hàng trả, sự kiện làm lúc phiếu ghi sổ (#112).
import { getVariants } from '../../catalog/index.ts';
import { type DocumentRef, mergeLines, type StockLine } from '../domain/documents.ts';
import { type DocumentSourceType, returnInspectionOf } from '../repository/documents.ts';
import { companyOfTransaction } from '../repository/levels.ts';
import { createSystemDocument } from './documents.ts';

const SOURCE_TYPES: readonly string[] = ['package', 'return_request'] satisfies DocumentSourceType[];

/**
 * Lập phiếu `KT` nháp với số dự kiến theo SKU, không đổi tồn, không phát sự kiện. Nguồn đã có phiếu kiểm hàng hoàn thì
 * trả phiếu đó; bên gọi chuyển trạng thái kiện, yêu cầu trả có điều kiện nên hai lần gọi không chạy song song.
 */
export async function receiveBack(source: { type: DocumentSourceType; id: string }, lines: readonly StockLine[]): Promise<DocumentRef> {
  companyOfTransaction();
  if (!SOURCE_TYPES.includes(source.type)) throw new Error(`Nguồn hàng quay về không hợp lệ: ${source.type}`);
  const expected = mergeLines(lines);
  if (!expected.size) throw new Error(`Hàng quay về từ ${source.type} ${source.id} không có dòng hàng`);
  // Hàm không khoá dòng tồn nên tự kiểm SKU thuộc công ty (spec #206 mục 5.6).
  const ids = [...expected.keys()];
  const owned = new Set((await getVariants(ids)).map((v) => v.id));
  const foreign = ids.filter((id) => !owned.has(id));
  if (foreign.length) throw new Error(`Biến thể không thuộc công ty: ${foreign.join(', ')}`);

  const existing = await returnInspectionOf(source.type, source.id);
  if (existing) return existing;
  const { ref } = await createSystemDocument({
    kind: 'return_inspection',
    status: 'draft',
    sourceType: source.type,
    sourceId: source.id,
    actorId: null,
    note: null,
    lines: [...expected].map(([variantId, q]) => ({ variantId, quantity: null, expectedQty: q, unitCost: null })),
  });
  return ref;
}
