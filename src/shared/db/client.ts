import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../config/env.ts';

export type Database = NodePgDatabase;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

let pool: pg.Pool | undefined;
let database: Database | undefined;

function rootDb(): Database {
  if (!database) {
    if (!env.DATABASE_URL) throw new Error('Chưa đặt DATABASE_URL');
    pool = new pg.Pool({ connectionString: env.DATABASE_URL });
    database = drizzle({ client: pool });
  }
  return database;
}

// Transaction đang mở của yêu cầu hiện tại (docs/17 mục 2, luật 3), kèm công ty nếu mở bằng withCompany.
interface OpenTransaction {
  readonly tx: Transaction;
  readonly companyId: string | null;
}
const current = new AsyncLocalStorage<OpenTransaction>();

/** Repository luôn lấy kết nối qua đây để tự đi chung transaction của bên gọi nếu có. */
export function getDb(): Database | Transaction {
  return current.getStore()?.tx ?? rootDb();
}

/**
 * Chạy `fn` trong một transaction. Nếu đã có transaction mở thì dùng lại,
 * nên service của module A gọi sang module B vẫn nằm trong cùng một giao dịch.
 */
export async function inTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  const existing = current.getStore();
  if (existing) return fn(existing.tx);
  return rootDb().transaction((tx) => current.run({ tx, companyId: null }, () => fn(tx)));
}

/**
 * Chạy `fn` trong transaction của một công ty: `SET LOCAL ROLE commerio_app` và `app.company_id`,
 * nên Row-Level Security chỉ cho thấy dữ liệu của công ty đó (db/CLAUDE.md). Đang ở trong withCompany
 * cùng công ty thì dùng lại. Lồng vào giao dịch khác (công ty khác, hoặc giao dịch của role chủ bảng như
 * luồng đăng ký) là lỗi lập trình: SET LOCAL sẽ đổi role cho cả phần còn lại của giao dịch đó.
 */
export async function withCompany<T>(companyId: string, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  const existing = current.getStore();
  if (existing) {
    if (existing.companyId === companyId) return fn(existing.tx);
    const where = existing.companyId ? 'của công ty khác' : 'không thuộc công ty';
    throw new Error(`withCompany(${companyId}) không lồng được trong giao dịch ${where}`);
  }
  return rootDb().transaction(async (tx) => {
    // set_config(..., true) = SET LOCAL: hết hiệu lực khi giao dịch kết thúc. Gộp một câu cho đỡ một lượt đi về.
    await tx.execute(sql`select set_config('role', 'commerio_app', true), set_config('app.company_id', ${companyId}, true)`);
    return current.run({ tx, companyId }, () => fn(tx));
  });
}

/** Công ty của giao dịch đang mở bằng withCompany; `null` khi ở ngoài. */
export function currentCompanyId(): string | null {
  return current.getStore()?.companyId ?? null;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
  database = undefined;
}
