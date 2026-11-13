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

class CompanyLimitReached extends Error {}

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
 * Xin một lượt gọi sàn trong ngày (giờ Việt Nam) của `at` (#102, #215). Trong một giao dịch: cộng dòng tổng của app (dưới
 * `limit`), rồi cộng dòng của công ty (dưới phần của công ty, bấm tay 90%); dòng công ty đã đủ thì giao dịch rollback nên
 * dòng tổng không bị tính. Mọi lượt khoá dòng tổng trước rồi mới tới dòng công ty, nên đúng cho mọi tiến trình và không
 * khoá chéo. Chạy ngoài giao dịch của bên gọi: lượt ghi ngay, không giữ khoá dòng tổng tới khi giao dịch kia xong,
 * không mất khi giao dịch kia rollback.
 */
export async function reservePlatformCall(platform: Platform, limit: number, opts: ReserveOptions = {}): Promise<CallReservation> {
  const at = opts.at ?? new Date();
  const day = sql`(${at.toISOString()}::timestamptz at time zone 'Asia/Ho_Chi_Minh')::date`;
  const companyId = opts.companyId ?? null;
  try {
    return await outsideTransaction(() =>
      inTransaction(async (): Promise<CallReservation> => {
        if (!(await bump(platform, day, null, limit))) return 'daily_call_limit';
        if (!companyId) return 'ok';
        const { mine, total } = await activeShops(platform, companyId);
        const cap = companyCap(companyShare(limit, opts.companyMin ?? 0, mine, total), opts.background ?? false);
        if (cap <= 0 || !(await bump(platform, day, companyId, cap))) throw new CompanyLimitReached();
        return 'ok';
      }),
    );
  } catch (err) {
    if (err instanceof CompanyLimitReached) return 'company_call_limit';
    throw err;
  }
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
