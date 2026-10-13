import { AsyncLocalStorage } from 'node:async_hooks';
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

// Transaction đang mở của yêu cầu hiện tại (docs/17 mục 2, luật 3).
const currentTx = new AsyncLocalStorage<Transaction>();

/** Repository luôn lấy kết nối qua đây để tự đi chung transaction của bên gọi nếu có. */
export function getDb(): Database | Transaction {
  return currentTx.getStore() ?? rootDb();
}

/**
 * Chạy `fn` trong một transaction. Nếu đã có transaction mở thì dùng lại,
 * nên service của module A gọi sang module B vẫn nằm trong cùng một giao dịch.
 */
export async function inTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  const existing = currentTx.getStore();
  if (existing) return fn(existing);
  return rootDb().transaction((tx) => currentTx.run(tx, () => fn(tx)));
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
  database = undefined;
}
