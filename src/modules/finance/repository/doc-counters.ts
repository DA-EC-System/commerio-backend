import { sql } from 'drizzle-orm';
import { getDb } from '../../../shared/db/client.ts';
import { docCounters } from './schema.ts';

/**
 * Cấp số của (công ty, loại chứng từ); `next_number` là số kế tiếp sẽ cấp, cùng nghĩa với `inventory.doc_counters`
 * (#16). Một câu upsert khoá dòng đếm tới hết giao dịch: giao dịch song song nhận số liền nhau, rollback thì số được
 * dùng lại (không lỗ hổng).
 */
export async function takeNextNumber(companyId: string, docType: string): Promise<number> {
  const [row] = await getDb()
    .insert(docCounters)
    .values({ companyId, docType, nextNumber: 2 })
    .onConflictDoUpdate({
      target: [docCounters.companyId, docCounters.docType, docCounters.period],
      set: { nextNumber: sql`${docCounters.nextNumber} + 1` },
    })
    .returning({ n: sql<number>`${docCounters.nextNumber} - 1` });
  return Number(row!.n);
}
