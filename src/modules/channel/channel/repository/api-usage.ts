import { sql } from 'drizzle-orm';
import { getDb, outsideTransaction } from '../../../../shared/db/client.ts';
import { apiUsage } from './schema.ts';

type Platform = (typeof apiUsage.platform.enumValues)[number];

/**
 * Xin một lượt gọi sàn trong ngày (giờ Việt Nam) của `at`. Một câu upsert nguyên tử nên đúng cho mọi tiến trình;
 * đủ `limit` thì không cộng nữa và trả `false`. Chạy ngoài giao dịch của bên gọi: lượt ghi ngay, không giữ khoá dòng
 * đếm (dùng chung mọi công ty) tới khi giao dịch kia xong, không mất khi giao dịch kia rollback.
 */
export async function reservePlatformCall(platform: Platform, limit: number, at: Date = new Date()): Promise<boolean> {
  const rows = await outsideTransaction(() =>
    getDb()
      .insert(apiUsage)
      .values({ platform, day: sql`(${at.toISOString()}::timestamptz at time zone 'Asia/Ho_Chi_Minh')::date`, calls: 1 })
      .onConflictDoUpdate({
        target: [apiUsage.platform, apiUsage.day],
        set: { calls: sql`${apiUsage.calls} + 1` },
        setWhere: sql`${apiUsage.calls} < ${limit}`,
      })
      .returning({ calls: apiUsage.calls }),
  );
  return rows.length > 0;
}
