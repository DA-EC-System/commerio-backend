// Hàng quay về kho theo kiện hoàn hoặc yêu cầu trả (Documents/21 mục 11.1, 15.3; spec #206 mục 5.5, Q19). Chạy trong
// giao dịch của bên gọi. Chỉ lập phiếu kiểm hàng hoàn nháp: tồn, giá vốn hàng trả, sự kiện làm lúc phiếu ghi sổ (#112).
import { inTransaction } from '../../../../shared/db/client.ts';
import { pgError } from '../../../../shared/db/pg-error.ts';
import { type DocumentRef, mergeLines, type StockLine } from '../domain/documents.ts';
import { type DocumentSourceType, returnInspectionOf } from '../repository/documents.ts';
import { companyOfTransaction } from '../repository/levels.ts';
import { createSystemDocument } from './system-documents.ts';
import { assertOwnVariants } from './posting.ts';

const SOURCE_TYPES: readonly string[] = ['package', 'return_request'] satisfies DocumentSourceType[];

/** `meta` của `receiveBack` (Documents/21 mục 11.1, thêm ở #208); không truyền thì phiếu như trước #208. */
export interface ReceiveBackMeta {
  /** Mã chứng từ nguồn (mã kiện, mã yêu cầu trả) để hiện trên phiếu. */
  number?: string;
  /** Đơn và gian hàng cho `inventory.return_inspected` khi phiếu nguồn `return_request` ghi sổ (mục 11.2). */
  orderId?: string;
  shopId?: string | null;
  /** Giá vốn của dòng kiện gốc theo SKU; `null` khi dòng kiện không qua `ship`. */
  unitCosts?: Readonly<Record<string, string | null>>;
  note?: string;
}

/**
 * Lập phiếu `KT` nháp với số dự kiến theo SKU, không đổi tồn, không phát sự kiện. Nguồn đã có phiếu kiểm hàng hoàn thì
 * trả phiếu đó, kể cả khi hai lần gọi chạy song song (unique một phần `stock_documents_return_inspection_source_uq`).
 * `meta` (tuỳ chọn) ghi mã chứng từ nguồn, đơn, gian hàng, giá vốn dòng kiện gốc lên phiếu; `inventory.return_inspected`
 * chỉ phát lúc ghi sổ phiếu nguồn `return_request` có đơn (`service/documents.ts`).
 */
export async function receiveBack(
  source: { type: DocumentSourceType; id: string },
  lines: readonly StockLine[],
  meta: ReceiveBackMeta = {},
): Promise<DocumentRef> {
  companyOfTransaction();
  if (!SOURCE_TYPES.includes(source.type)) throw new Error(`Nguồn hàng quay về không hợp lệ: ${source.type}`);
  const expected = mergeLines(lines);
  if (!expected.size) throw new Error(`Hàng quay về từ ${source.type} ${source.id} không có dòng hàng`);
  // Hàm không khoá dòng tồn nên tự kiểm SKU thuộc công ty (spec #206 mục 5.6).
  await assertOwnVariants([...expected.keys()]);

  const existing = await returnInspectionOf(source.type, source.id);
  if (existing) return existing;
  try {
    // Savepoint: bên thua đụng unique thì chỉ lùi phần lập phiếu (cả số `KT` vừa cấp, không nhảy số), giao dịch của bên
    // gọi vẫn chạy tiếp được.
    return await inTransaction((tx) =>
      tx.transaction(async () => {
        const { ref } = await createSystemDocument({
          kind: 'return_inspection',
          status: 'draft',
          sourceType: source.type,
          sourceId: source.id,
          actorId: null,
          note: meta.note ?? (meta.number ? `Hàng về từ ${meta.number}` : null),
          sourceNumber: meta.number ?? null,
          orderId: meta.orderId ?? null,
          shopId: meta.shopId ?? null,
          lines: [...expected].map(([variantId, q]) => ({
            variantId,
            quantity: null,
            expectedQty: q,
            unitCost: meta.unitCosts?.[variantId] ?? null,
            sourceLineId: null,
          })),
        });
        return ref;
      }),
    );
  } catch (err) {
    // Lần gọi song song cùng nguồn đã lập phiếu và commit trước: trả phiếu đó.
    const { code, constraint } = pgError(err);
    if (code !== '23505' || constraint !== 'stock_documents_return_inspection_source_uq') throw err;
    const winner = await returnInspectionOf(source.type, source.id);
    if (!winner) throw err;
    return winner;
  }
}
