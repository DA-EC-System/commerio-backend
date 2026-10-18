import pg from 'pg';
import { inject } from 'vitest';

let pool: pg.Pool | undefined;

/** Pool tới DB của lượt test, bằng role chạy migration (chủ bảng, bỏ qua RLS). `setup.ts` đóng sau mỗi file. */
export function testPool(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: inject('databaseUrl') });
  return pool;
}

export async function closeTestPool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
