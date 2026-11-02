// Đọc hàng việc lỗi của pg-boss bằng SQL (#102 A6): `findJobs` không đếm, không sắp mới nhất trước, không nhảy trang.
// Cột theo schema pg-boss 12.38.0 (bản ghim, migration 0011); nâng pg-boss thì `dead-jobs.test.ts` báo nếu cột đổi.
// Gọi ngoài `withCompany` (role chủ bảng): `commerio_app` chỉ được gửi việc. Lọc công ty bằng `data.companyId`.
import { sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';

export interface DeadJobRow {
  id: string;
  queue: string | null;
  shopId: string | null;
  retryCount: number | null;
  output: unknown;
  failedAt: Date;
}

export async function findDeadJobs(
  deadQueue: string,
  companyId: string,
  filter: { queue?: string; limit: number; offset: number },
): Promise<{ rows: DeadJobRow[]; total: number }> {
  const where = sql`name = ${deadQueue} AND data @> ${JSON.stringify({ companyId })}::jsonb
    ${filter.queue ? sql`AND source_name = ${filter.queue}` : sql``}`;
  const db = getDb();
  const [rows, [count]] = await Promise.all([
    db.execute<{ id: string; queue: string | null; shop_id: string | null; retry_count: number | null; output: unknown; failed_at: Date }>(
      sql`SELECT id, source_name AS queue, data->>'shopId' AS shop_id, source_retry_count AS retry_count,
            source_output AS output, created_on AS failed_at
          FROM pgboss.job WHERE ${where}
          ORDER BY created_on DESC, id LIMIT ${filter.limit} OFFSET ${filter.offset}`,
    ),
    db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM pgboss.job WHERE ${where}`).then((r) => r.rows),
  ]);
  return {
    rows: rows.rows.map((r) => ({
      id: r.id,
      queue: r.queue,
      shopId: r.shop_id,
      retryCount: r.retry_count,
      output: r.output,
      failedAt: new Date(r.failed_at),
    })),
    total: count?.n ?? 0,
  };
}
