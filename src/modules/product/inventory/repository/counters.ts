import { sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { companyOfTransaction } from './levels.ts';
import { docCounters } from './schema.ts';

/**
 * Cấp số kế tiếp của (công ty, loại chứng từ) từ `product.doc_counters`, bắt đầu từ 1. Một câu upsert khoá dòng đếm
 * tới hết giao dịch: giao dịch song song nhận số liền nhau, rollback thì số được dùng lại (như finance `takeNextNumber`).
 */
export async function takeNextNumber(docType: string): Promise<number> {
  const [row] = await getDb()
    .insert(docCounters)
    .values({ companyId: companyOfTransaction(), docType, nextNumber: 2 })
    .onConflictDoUpdate({
      target: [docCounters.companyId, docCounters.docType, docCounters.period],
      set: { nextNumber: sql`${docCounters.nextNumber} + 1` },
    })
    .returning({ n: sql<number>`${docCounters.nextNumber} - 1` });
  return Number(row!.n);
}
