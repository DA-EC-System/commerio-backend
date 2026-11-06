// Dựng `StockDocSummary`, `StockDoc` cho API (Documents/21 mục 15.2, kiểu ở FE `src/types/inventory.ts`; #208).
// Chạy trong `withCompany` của bên gọi.
import { getStatusHistory } from '../../../core/index.ts';
import { getVariants } from '../../catalog/index.ts';
import { decreaseOf, type DocType, type ManualDocType, needsDecision } from '../domain/stock-document.ts';
import { toDong } from '../domain/stock.ts';
import { type DocLineRow, type DocRow, docRefsOf, docsFromDocs, linesOfDocs } from '../repository/documents.ts';
import { namesOf, type Viewer } from './views.ts';

export const DOC_ENTITY = 'stock_documents';
export const DOC_AUDIT_ENTITY = 'product.stock_documents';

/** Phiếu trả NCC sinh từ phiếu kho: purchasing import inventory nên nối qua `product/index.ts` (`setSupplierReturnPort`). */
export interface SupplierReturnPort {
  draft(input: {
    source: 'quarantine' | 'customer_return' | 'write_off_rejected';
    sourceId: string;
    lines: readonly { variantId: string; quantity: number; unitCost: string | null; sourceLineId: string | null }[];
    note: string;
  }): Promise<{ id: string; number: string }>;
  fromDocuments(docIds: readonly string[]): Promise<{ id: string; number: string; sourceId: string | null }[]>;
}

let supplierReturns: SupplierReturnPort | null = null;

export function setSupplierReturnPort(port: SupplierReturnPort): void {
  supplierReturns = port;
}

export function supplierReturnPort(): SupplierReturnPort {
  if (!supplierReturns) throw new Error('Chưa nối phiếu trả NCC của purchasing (setSupplierReturnPort ở src/modules/product/index.ts)');
  return supplierReturns;
}

const DOC_REF_TYPES = ['order', 'package', 'return_request', 'stock_document', 'goods_receipt', 'supplier_return', 'purchase_request'] as const;
type DocRefType = (typeof DOC_REF_TYPES)[number];
export interface DocRef {
  type: DocRefType;
  id: string;
  number: string;
}

const isRefType = (t: string | null): t is DocRefType => !!t && (DOC_REF_TYPES as readonly string[]).includes(t);
export const docType = (row: DocRow) => row.kind as DocType;
/** Ngăn của kiểm kê, xuất huỷ (API gọi tồn thực là `stock`); loại khác không có. */
export const apiArea = (row: DocRow) =>
  row.kind === 'stocktake' || row.kind === 'write_off' ? (row.area === 'on_hand' ? ('stock' as const) : ('quarantine' as const)) : null;
/** Lập tay hay hệ thống sinh (kiểm hàng về, xuất huỷ phần hỏng, kiểm kê đầu kỳ). */
const kindOf = (row: DocRow) => (row.kind === 'return_inspection' || row.sourceType ? ('auto' as const) : ('manual' as const));

/** Số trên dòng theo loại phiếu: kiểm kê là Δ = đếm − sổ, kiểm hàng về là số quét. */
export function lineQuantity(row: DocRow, l: DocLineRow): number {
  if (row.kind === 'stocktake') return (l.countedQty ?? 0) - (l.bookQty ?? 0);
  if (row.kind === 'return_inspection') return l.scannedQty ?? 0;
  return l.quantity ?? 0;
}

async function sourceRefs(rows: readonly DocRow[]): Promise<Map<string, DocRef>> {
  const docIds = rows.flatMap((r) => (r.sourceType === 'stock_document' && r.sourceId ? [r.sourceId] : []));
  const numbers = new Map((await docRefsOf(docIds)).map((d) => [d.id, d.number]));
  const out = new Map<string, DocRef>();
  for (const r of rows) {
    if (!isRefType(r.sourceType) || !r.sourceId) continue;
    out.set(r.id, { type: r.sourceType, id: r.sourceId, number: numbers.get(r.sourceId) ?? r.sourceNumber ?? '' });
  }
  return out;
}

export async function summaries(rows: readonly DocRow[]) {
  const lines = await linesOfDocs(rows.map((r) => r.id));
  const names = await namesOf(rows.flatMap((r) => [r.createdBy, r.postedBy]));
  const sources = await sourceRefs(rows);
  return rows.map((r) => {
    const own = lines.get(r.id) ?? [];
    return {
      id: r.id,
      number: r.number,
      type: docType(r),
      kind: kindOf(r),
      status: r.status,
      area: apiArea(r),
      note: r.note ?? '',
      source: sources.get(r.id) ?? null,
      claimFlag: r.claimFlag,
      lineCount: own.length,
      totalQty: own.reduce((s, l) => s + lineQuantity(r, l), 0),
      createdBy: r.createdBy ? (names.get(r.createdBy) ?? '') : 'Hệ thống',
      createdById: r.createdBy ?? '',
      createdAt: r.createdAt.toISOString(),
      postedBy: r.postedBy ? (names.get(r.postedBy) ?? '') : null,
      postedAt: r.postedAt?.toISOString() ?? null,
      version: r.version,
    };
  });
}

/** Chi tiết phiếu: dòng kèm nhãn biến thể, lịch sử, phiếu sinh tiếp. Giá vốn chỉ khi có `inventory.cost.view`. */
export async function detail(row: DocRow, viewer: Pick<Viewer, 'canCost'>) {
  const [summary] = await summaries([row]);
  const lines = (await linesOfDocs([row.id])).get(row.id) ?? [];
  const variants = new Map((await getVariants(lines.map((l) => l.variantId))).map((v) => [v.id, v]));
  const pending = row.status === 'pending' && row.area === 'on_hand' && row.kind !== 'return_inspection';
  const followUps: DocRef[] = [
    ...(await docsFromDocs([row.id])).map((d) => ({ type: 'stock_document' as const, id: d.id, number: d.number })),
    ...(await supplierReturnPort().fromDocuments([row.id])).map((d) => ({ type: 'supplier_return' as const, id: d.id, number: d.number })),
  ];
  return {
    ...summary!,
    lines: lines.map((l) => {
      const v = variants.get(l.variantId);
      return {
        variantId: l.variantId,
        sku: v?.sku ?? '',
        productName: v?.productName ?? '',
        attributesLabel: v ? v.attributes.map((a) => a.value).join(' / ') : '',
        quantity: lineQuantity(row, l),
        ...(row.kind === 'stocktake' && { bookQty: l.bookQty ?? 0, counted: l.countedQty ?? 0 }),
        ...(row.kind === 'return_inspection' && {
          expected: l.expectedQty ?? 0,
          resell: l.resellQty ?? 0,
          damaged: l.damagedQty ?? 0,
          toSupplier: l.toSupplierQty ?? 0,
        }),
        ...(pending && { locked: decreaseOf(row.kind as ManualDocType, l) }),
        unitCost: viewer.canCost && l.unitCost !== null ? toDong(l.unitCost) : null,
      };
    }),
    statusHistory: await getStatusHistory(DOC_ENTITY, row.id),
    followUps,
    rejectDecision: row.rejectDecision,
    needsDecision: needsDecision(row),
  };
}
