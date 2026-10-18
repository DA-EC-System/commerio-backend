/** Mã lỗi và tên ràng buộc PostgreSQL (Drizzle bọc lỗi gốc trong `cause`). */
export function pgError(err: unknown): { code?: string; constraint?: string } {
  return (err as { cause?: { code?: string; constraint?: string } }).cause ?? (err as { code?: string; constraint?: string });
}
