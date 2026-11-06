// Phiếu kho do hệ thống lập theo kiện hoặc yêu cầu trả (spec #206 mục 5.3): phiếu xuất `shipment`, phiếu đảo
// `shipment_reversal`, phiếu kiểm hàng hoàn `return_inspection`. Mọi hàm chạy trong `withCompany` của bên gọi.
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import type { DocumentRef, SystemDocKind } from '../domain/documents.ts';
import { companyOfTransaction } from './levels.ts';
import { stockDocumentLines, stockDocuments } from './schema.ts';

export type DocumentSourceType = 'package' | 'return_request';

export interface NewSystemDocument {
  number: string;
  kind: SystemDocKind;
  status: 'posted' | 'draft';
  sourceType: DocumentSourceType;
  sourceId: string;
  /** Người lập; trống khi sàn hoặc hệ thống lập. Phiếu `posted` ghi luôn làm người ghi sổ. */
  actorId: string | null;
  note: string | null;
}

export async function insertDocument(d: NewSystemDocument): Promise<string> {
  const posted = d.status === 'posted';
  const [row] = await getDb()
    .insert(stockDocuments)
    .values({
      companyId: companyOfTransaction(),
      number: d.number,
      kind: d.kind,
      status: d.status,
      sourceType: d.sourceType,
      sourceId: d.sourceId,
      note: d.note,
      createdBy: d.actorId,
      postedBy: posted ? d.actorId : null,
      postedAt: posted ? sql`now()` : null,
      // Giờ lúc chèn, sau khi đã khoá dòng tồn, không phải giờ đầu giao dịch: lượt bàn giao sắp theo cột này (Q22).
      createdAt: sql`clock_timestamp()`,
    })
    .returning({ id: stockDocuments.id });
  return row!.id;
}

export interface NewDocumentLine {
  variantId: string;
  quantity: number | null;
  expectedQty: number | null;
  unitCost: string | null;
}

/** Chèn dòng phiếu (mỗi SKU một dòng), trả `variantId → id dòng phiếu` để thẻ kho trỏ về. */
export async function insertDocumentLines(documentId: string, lines: readonly NewDocumentLine[]): Promise<Map<string, string>> {
  if (!lines.length) return new Map();
  const companyId = companyOfTransaction();
  const rows = await getDb()
    .insert(stockDocumentLines)
    .values(lines.map((l) => ({ companyId, documentId, ...l })))
    .returning({ id: stockDocumentLines.id, variantId: stockDocumentLines.variantId });
  return new Map(rows.map((r) => [r.variantId, r.id]));
}

export interface ShipmentDoc {
  id: string;
  number: string;
  kind: 'shipment' | 'shipment_reversal';
  lines: { variantId: string; quantity: number; unitCost: string }[];
}

/** Mọi phiếu xuất, phiếu đảo của kiện kèm dòng, cũ trước (theo `created_at`, Q22). */
export async function packageShipments(packageId: string): Promise<ShipmentDoc[]> {
  const companyId = companyOfTransaction();
  const docs = await getDb()
    .select({ id: stockDocuments.id, number: stockDocuments.number, kind: stockDocuments.kind })
    .from(stockDocuments)
    .where(
      and(
        eq(stockDocuments.companyId, companyId),
        eq(stockDocuments.sourceType, 'package'),
        eq(stockDocuments.sourceId, packageId),
        inArray(stockDocuments.kind, ['shipment', 'shipment_reversal']),
      ),
    )
    .orderBy(asc(stockDocuments.createdAt), asc(stockDocuments.id));
  if (!docs.length) return [];
  const lines = await getDb()
    .select({
      documentId: stockDocumentLines.documentId,
      variantId: stockDocumentLines.variantId,
      quantity: stockDocumentLines.quantity,
      unitCost: stockDocumentLines.unitCost,
    })
    .from(stockDocumentLines)
    .where(
      and(
        eq(stockDocumentLines.companyId, companyId),
        inArray(
          stockDocumentLines.documentId,
          docs.map((d) => d.id),
        ),
      ),
    );
  return docs.map((d) => ({
    id: d.id,
    number: d.number,
    kind: d.kind as ShipmentDoc['kind'],
    // Dòng phiếu xuất, phiếu đảo luôn có `quantity` và `unit_cost` (spec #206 mục 5.3).
    lines: lines.filter((l) => l.documentId === d.id).map((l) => ({ variantId: l.variantId, quantity: l.quantity!, unitCost: l.unitCost! })),
  }));
}

/** Phiếu kiểm hàng hoàn đã lập cho một nguồn (kiện hoặc yêu cầu trả), nếu có. */
export async function returnInspectionOf(sourceType: DocumentSourceType, sourceId: string): Promise<DocumentRef | null> {
  const [row] = await getDb()
    .select({ documentId: stockDocuments.id, number: stockDocuments.number })
    .from(stockDocuments)
    .where(
      and(
        eq(stockDocuments.companyId, companyOfTransaction()),
        eq(stockDocuments.kind, 'return_inspection'),
        eq(stockDocuments.sourceType, sourceType),
        eq(stockDocuments.sourceId, sourceId),
      ),
    )
    .orderBy(asc(stockDocuments.createdAt))
    .limit(1);
  return row ?? null;
}
