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
