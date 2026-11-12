// Hàng quay về kho theo kiện hoàn, yêu cầu trả hoặc kiện trả không khớp (Documents/21 mục 11.1, 15.3, 20; 25 §7.3;
// spec #206 mục 5.5; #208 đổi 11/11/2026 theo Documents#102, #103). Chạy trong giao dịch của bên gọi. Lập phiếu kiểm hàng
// hoàn nháp và cộng chờ xử lý ngay theo số quét từng món; tồn thực, giá vốn, sự kiện làm lúc phiếu ghi sổ.
import { inTransaction } from '../../../../shared/db/client.ts';
import { pgError } from '../../../../shared/db/pg-error.ts';
import { publishEvent, recordTransition } from '../../../core/index.ts';
import { DOC_PREFIX, docNumber, type DocumentRef } from '../domain/documents.ts';
import { takeNextNumber } from '../repository/counters.ts';
import {
  type DocumentSourceType,
  findDoc,
  findDocBySource,
  insertDoc,
  insertDocLines,
  linesOfDocs,
  type NewDocLine,
  replaceDocLines,
  returnInspectionOf,
  updateDoc,
} from '../repository/documents.ts';
import { companyOfTransaction } from '../repository/levels.ts';
import { applyMoves, assertOwnVariants } from './posting.ts';

const SOURCE_TYPES: readonly string[] = ['package', 'return_request', 'unmatched_parcel'] satisfies DocumentSourceType[];

/** Một món của hàng quay về: bên gọi đã gộp dòng nguồn với số kho quét (mục 11.1, đổi 11/11/2026). */
export interface ReturnedLine {
  variantId: string;
  /** Số dự kiến theo nguồn; 0 với món ngoài nguồn (sai mẫu). */
  expected: number;
  /** Số kho quét lúc nhận; 0 với món nguồn vắng (tính là thiếu). */
  scanned: number;
}

/** `meta` của `receiveBack` (Documents/21 mục 11.1, thêm ở #208). */
export interface ReceiveBackMeta {
  /** Người quét: ghi vào thẻ kho và phiếu; người duyệt phần thiếu phải khác người này (mục 15.3). */
  actorId?: string | null;
  /** Mã chứng từ nguồn (mã kiện, mã yêu cầu trả) để hiện trên phiếu. */
  number?: string;
  /** Đơn và gian hàng cho `inventory.return_inspected` khi phiếu nguồn `return_request` ghi sổ (mục 11.2). */
  orderId?: string;
  shopId?: string | null;
  /** Giá vốn của dòng kiện gốc theo SKU; `null` khi dòng kiện không qua `ship`. */
  unitCosts?: Readonly<Record<string, string | null>>;
  note?: string;
  /**
   * Gắn kiện trả không khớp đã nhận vào yêu cầu (nguồn `return_request`, mục 20): chuyển phiếu sẵn có của kiện sang
   * nguồn là yêu cầu, đặt lại số dự kiến theo `lines`, không đổi chờ xử lý (đã cộng lúc nhận kiện).
   */
  fromUnmatchedParcelId?: string;
}

/** Gộp dòng theo SKU; số không nguyên hoặc âm là bên gọi vi phạm hợp đồng (route đã kiểm bằng Zod). */
function merge(lines: readonly ReturnedLine[], source: DocumentSourceType): Map<string, { expected: number; scanned: number }> {
  const out = new Map<string, { expected: number; scanned: number }>();
  for (const l of lines) {
    for (const n of [l.expected, l.scanned]) {
      if (!Number.isInteger(n) || n < 0) throw new Error(`Số lượng của ${l.variantId} phải là số nguyên không âm: ${n}`);
    }
    const cur = out.get(l.variantId) ?? { expected: 0, scanned: 0 };
    out.set(l.variantId, { expected: cur.expected + l.expected, scanned: cur.scanned + l.scanned });
  }
  for (const [id, l] of out) {
    // Kiện lạ không có số dự kiến để so: dự kiến bằng số quét, phiếu không có phần thiếu (Documents#103)
    if (source === 'unmatched_parcel') l.expected = l.scanned;
    if (l.expected === 0 && l.scanned === 0) out.delete(id);
  }
  return out;
}

/**
 * Lập phiếu `KT` nháp có sẵn số dự kiến, số quét từng dòng và cộng chờ xử lý ngay theo số quét (thẻ kho ngăn
 * `quarantine`, nguồn là phiếu vừa sinh); tồn thực chưa đổi, không phát sự kiện. Nguồn đã có phiếu kiểm hàng hoàn thì trả
 * phiếu đó và không cộng lần nữa, kể cả khi hai lần gọi chạy song song (unique một phần
 * `stock_documents_return_inspection_source_uq`). Kiện trả không khớp (`unmatched_parcel`) nhận cả khi chưa món nào rõ
 * SKU (phiếu không dòng, kho ghi SKU thực nhận trên phiếu sau).
 */
export async function receiveBack(
  source: { type: DocumentSourceType; id: string },
  lines: readonly ReturnedLine[],
  meta: ReceiveBackMeta = {},
): Promise<DocumentRef> {
  const companyId = companyOfTransaction();
  if (!SOURCE_TYPES.includes(source.type)) throw new Error(`Nguồn hàng quay về không hợp lệ: ${source.type}`);
  const merged = merge(lines, source.type);
  if (!merged.size && source.type !== 'unmatched_parcel') throw new Error(`Hàng quay về từ ${source.type} ${source.id} không có dòng hàng`);
  // Hàm tự kiểm SKU thuộc công ty trước khi lập phiếu (spec #206 mục 5.6).
  await assertOwnVariants([...merged.keys()]);

  const existing = await returnInspectionOf(source.type, source.id);
  if (existing) return existing;
  if (meta.fromUnmatchedParcelId && source.type === 'return_request') {
    const moved = await adoptParcelDocument(companyId, meta.fromUnmatchedParcelId, source.id, merged, meta);
    if (moved) return moved;
  }
  const actorId = meta.actorId ?? null;
  try {
    // Savepoint: bên thua đụng unique thì chỉ lùi phần lập phiếu (cả số `KT` vừa cấp và phần cộng chờ xử lý), giao dịch
    // của bên gọi vẫn chạy tiếp được.
    return await inTransaction((tx) =>
      tx.transaction(async () => {
        const row = await insertDoc({
          companyId,
          number: docNumber(DOC_PREFIX.return_inspection, await takeNextNumber('return_inspection')),
          kind: 'return_inspection',
          status: 'draft',
          sourceType: source.type,
          sourceId: source.id,
          note: meta.note ?? (meta.number ? `Hàng về từ ${meta.number}` : null),
          sourceNumber: meta.number ?? null,
          orderId: meta.orderId ?? null,
          shopId: meta.shopId ?? null,
          createdBy: actorId,
        });
        await insertDocLines(
          companyId,
          row.id,
          [...merged].map(
            ([variantId, l]): NewDocLine => ({
              variantId,
              expectedQty: l.expected,
              // Chưa chia bán lại / hỏng / trả NCC: để trống (CHECK `stock_document_lines_inspection_sum` chỉ xét khi đã chia)
              scannedQty: l.scanned,
              unitCost: meta.unitCosts?.[variantId] ?? null,
            }),
          ),
        );
        await recordTransition({ entityType: 'stock_documents', entityId: row.id, from: null, to: 'draft', action: 'create', actorId });
        await applyMoves(
          { type: 'stock_document', id: row.id },
          [...merged].map(([variantId, l]) => ({ variantId, bucket: 'quarantine' as const, qty: l.scanned, unitCost: null, sourceLineId: null })),
          actorId,
        );
        return { documentId: row.id, number: row.number };
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

/**
 * Chuyển phiếu kiểm hàng hoàn của kiện trả không khớp sang nguồn là yêu cầu trả. Phiếu còn nháp thì đặt lại số dự kiến
 * theo dòng yêu cầu (món yêu cầu chưa có trên phiếu thêm dòng quét 0, món ngoài yêu cầu dự kiến 0); số quét và chờ xử lý
 * giữ nguyên. Kiện chưa có phiếu thì `null` (bên gọi lập phiếu mới).
 */
async function adoptParcelDocument(
  companyId: string,
  parcelId: string,
  requestId: string,
  merged: ReadonlyMap<string, { expected: number; scanned: number }>,
  meta: ReceiveBackMeta,
): Promise<DocumentRef | null> {
  const found = await findDocBySource('return_inspection', 'unmatched_parcel', parcelId);
  const row = found ? await findDoc(found.id, 'update') : undefined;
  if (!row) return null;
  const updated = await updateDoc(row.id, row.version, {
    sourceType: 'return_request',
    sourceId: requestId,
    ...(meta.number !== undefined && { sourceNumber: meta.number }),
    ...(meta.orderId !== undefined && { orderId: meta.orderId }),
    ...(meta.shopId !== undefined && { shopId: meta.shopId }),
  });
  if (!updated) throw new Error(`Phiếu ${row.number} đổi trong lúc gắn kiện vào yêu cầu trả`);
  if (row.status === 'draft') {
    const old = (await linesOfDocs([row.id])).get(row.id) ?? [];
    const seen = new Set(old.map((l) => l.variantId));
    const lines: NewDocLine[] = [
      ...old.map((l) => ({
        variantId: l.variantId,
        expectedQty: merged.get(l.variantId)?.expected ?? 0,
        scannedQty: l.scannedQty ?? 0,
        resellQty: l.resellQty,
        damagedQty: l.damagedQty,
        toSupplierQty: l.toSupplierQty,
        unitCost: l.unitCost ?? meta.unitCosts?.[l.variantId] ?? null,
      })),
      ...[...merged]
        .filter(([id, l]) => !seen.has(id) && l.expected > 0)
        .map(([variantId, l]) => ({
          variantId,
          expectedQty: l.expected,
          scannedQty: 0,
          resellQty: 0,
          damagedQty: 0,
          toSupplierQty: 0,
          unitCost: meta.unitCosts?.[variantId] ?? null,
        })),
    ];
    await replaceDocLines(companyId, row.id, lines);
  } else if (row.status === 'posted' && (meta.orderId ?? row.orderId)) {
    // Phiếu của kiện đã ghi sổ trước khi gắn (kho ghi sổ được ngay, Documents/21 mục 20): lúc ghi sổ nguồn còn là kiện nên
    // chưa phát `inventory.return_inspected`. Phát bây giờ để yêu cầu trả đóng được (#202), cùng payload với lúc ghi sổ.
    const posted = (await linesOfDocs([row.id])).get(row.id) ?? [];
    await publishEvent({
      type: 'inventory.return_inspected',
      aggregateId: row.id,
      payload: {
        inspectionId: row.id,
        orderId: (meta.orderId ?? row.orderId)!,
        shopId: meta.shopId !== undefined ? meta.shopId : row.shopId,
        inspectedAt: (row.postedAt ?? new Date()).toISOString(),
        lines: posted.map((l) => ({ variantId: l.variantId, resellable: l.resellQty ?? 0, unitCost: l.unitCost })),
      },
    });
  }
  return { documentId: row.id, number: row.number };
}
