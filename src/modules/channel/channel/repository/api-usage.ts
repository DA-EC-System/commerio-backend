import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb, inTransaction, outsideTransaction } from '../../../../shared/db/client.ts';
import { companyCap, companyShare } from '../domain/call-quota.ts';
import { apiUsage, shops } from './schema.ts';

type Platform = (typeof apiUsage.platform.enumValues)[number];

/** Kết quả xin lượt: `ok`, hết trần chung của app, hoặc hết phần của công ty (Documents/21 §14.5, §18.6.8). */
export type CallReservation = 'ok' | 'daily_call_limit' | 'company_call_limit';

export interface ReserveOptions {
  /** Công ty của lời gọi; trống thì chỉ tính trần chung (lời gọi không gắn được công ty nào). */
  companyId?: string | null;
  /** Việc nền chạy tới 100% phần của công ty; thao tác bấm tay dừng ở 90% (§18.6.8). */
  background?: boolean;
  /** Phần tối thiểu của một công ty mỗi ngày (`CHANNEL_COMPANY_MIN_CALLS`). */
  companyMin?: number;
  at?: Date;
}

/** Hết trần chung sau khi đã cộng dòng công ty: ném để rollback cả dòng công ty. */
class DailyLimitReached extends Error {}

/** Cộng một lượt vào dòng (sàn, ngày, công ty) nếu dòng đang dưới `cap`; trả `false` khi đã đủ. */
async function bump(platform: Platform, day: ReturnType<typeof sql>, companyId: string | null, cap: number): Promise<boolean> {
  const rows = await getDb()
    .insert(apiUsage)
    .values({ platform, day, companyId, calls: 1 })
    .onConflictDoUpdate({
      target: [apiUsage.platform, apiUsage.day, apiUsage.companyId],
      set: { calls: sql`${apiUsage.calls} + 1` },
      setWhere: sql`${apiUsage.calls} < ${cap}`,
    })
    .returning({ calls: apiUsage.calls });
  return rows.length > 0;
}

/** Số gian hàng `active` của công ty và của mọi công ty trên sàn (role chủ bảng nên đếm được mọi công ty). */
async function activeShops(platform: Platform, companyId: string): Promise<{ mine: number; total: number }> {
  const [row] = await getDb()
    .select({
      mine: sql<number>`count(*) filter (where ${shops.companyId} = ${companyId})::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(shops)
    .where(and(eq(shops.platform, platform), eq(shops.status, 'active')));
  return { mine: row?.mine ?? 0, total: row?.total ?? 0 };
}

/**
 * Xin một lượt gọi sàn trong ngày (giờ Việt Nam) của `at` (#102, #215).
 *
 * Đếm gian hàng active (tính phần của công ty) trước, ngoài giao dịch: câu đọc không cần khoá. Rồi trong một giao dịch
 * ngắn chỉ có hai câu upsert: cộng dòng công ty (dưới phần, bấm tay 90%) trước, dòng tổng của app (dưới `limit`) sau.
 * Hết phần công ty thì chưa đụng dòng tổng (không khoá dòng chung của cả app); hết trần chung thì rollback cả dòng công
 * ty. Khoá dòng tổng chỉ giữ từ câu upsert thứ hai tới commit. Mọi lượt khoá theo cùng thứ tự (một dòng công ty, rồi dòng
 * tổng) nên không khoá chéo, đúng cho mọi tiến trình. Chạy ngoài giao dịch của bên gọi: lượt ghi ngay, không giữ khoá tới
 * khi giao dịch kia xong, không mất khi giao dịch kia rollback.
 *
 * Phần của công ty tính trên số gian hàng đọc ngay trước giao dịch; gian hàng đổi trạng thái giữa hai bước chỉ làm phần
 * lệch ở một lượt.
 */
export async function reservePlatformCall(platform: Platform, limit: number, opts: ReserveOptions = {}): Promise<CallReservation> {
  const at = opts.at ?? new Date();
  const day = sql`(${at.toISOString()}::timestamptz at time zone 'Asia/Ho_Chi_Minh')::date`;
  const companyId = opts.companyId ?? null;
  return outsideTransaction(async () => {
    let cap = 0;
    if (companyId) {
      const { mine, total } = await activeShops(platform, companyId);
      cap = companyCap(companyShare(limit, opts.companyMin ?? 0, mine, total), opts.background ?? false);
      if (cap <= 0) return 'company_call_limit';
    }
    try {
      return await inTransaction(async (): Promise<CallReservation> => {
        if (companyId && !(await bump(platform, day, companyId, cap))) return 'company_call_limit';
        if (!(await bump(platform, day, null, limit))) throw new DailyLimitReached();
        return 'ok';
      });
    } catch (err) {
      if (err instanceof DailyLimitReached) return 'daily_call_limit';
      throw err;
    }
  });
}

/** Số lượt đã dùng trong ngày của `at`: của cả app (`companyId` trống) hoặc của một công ty. Cho test và giám sát. */
export async function usedCalls(platform: Platform, companyId: string | null, at: Date = new Date()): Promise<number> {
  const day = sql`(${at.toISOString()}::timestamptz at time zone 'Asia/Ho_Chi_Minh')::date`;
  const [row] = await outsideTransaction(() =>
    getDb()
      .select({ calls: apiUsage.calls })
      .from(apiUsage)
      .where(and(eq(apiUsage.platform, platform), sql`${apiUsage.day} = ${day}`, companyId ? eq(apiUsage.companyId, companyId) : isNull(apiUsage.companyId))),
  );
  return row?.calls ?? 0;
}
