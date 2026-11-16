interface PgErrorFields {
  code?: string;
  constraint?: string;
  cause?: unknown;
}

/** Mã lỗi và tên ràng buộc PostgreSQL. Drizzle bọc lỗi gốc của `pg` trong `cause` (`DrizzleQueryError`). */
export function pgError(err: unknown): { code?: string; constraint?: string } {
  const outer = err as PgErrorFields | null | undefined;
  const source = outer?.code ? outer : (outer?.cause as PgErrorFields | null | undefined);
  return { code: source?.code, constraint: source?.constraint };
}

/**
 * Không lấy được kết nối: pool của tiến trình chờ quá `DB_CONNECT_TIMEOUT_MS`, hoặc Session pooler từ chối vì đã đủ
 * `pool_size` (`EMAXCONNSESSION`, #335). Lỗi tạm thời, thử lại sau giây lát là được.
 */
export function isConnectionUnavailable(err: unknown): boolean {
  for (let e = err as { message?: unknown; cause?: unknown } | null | undefined, depth = 0; e && depth < 5; e = e.cause as typeof e, depth++) {
    const message = typeof e.message === 'string' ? e.message : '';
    if (/timeout exceeded when trying to connect|EMAXCONNSESSION|max clients reached/i.test(message)) return true;
  }
  return false;
}
