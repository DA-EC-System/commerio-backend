// Chứng từ gốc của thẻ kho (#206 phần 2a): số phiếu và các cột quyết định nhóm chứng từ của phiếu kho.
import { and, eq, inArray } from 'drizzle-orm';
import { getDb, requireCompanyId } from '../../../../shared/db/client.ts';
import { stockDocuments } from './schema.ts';

export interface DocumentHead {
  number: string;
  kind: (typeof stockDocuments.$inferSelect)['kind'];
  isOpening: boolean;
  sourceType: string | null;
}

/** Phiếu kho theo id, một câu theo khoá chính; id không có (hoặc của công ty khác) thì vắng trong Map. */
export async function documentHeads(ids: readonly string[]): Promise<Map<string, DocumentHead>> {
  const companyId = requireCompanyId('documentHeads');
  if (!ids.length) return new Map();
  const rows = await getDb()
    .select({
      id: stockDocuments.id,
      number: stockDocuments.number,
      kind: stockDocuments.kind,
      isOpening: stockDocuments.isOpening,
      sourceType: stockDocuments.sourceType,
    })
    .from(stockDocuments)
    .where(and(eq(stockDocuments.companyId, companyId), inArray(stockDocuments.id, [...ids])));
  return new Map(rows.map(({ id, ...head }) => [id, head]));
}
