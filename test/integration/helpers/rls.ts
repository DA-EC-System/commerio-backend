import type pg from 'pg';
import { testPool } from './db.ts';

/** Chạy `fn` như một request trong công ty: role commerio_app và app.company_id, rồi rollback. */
export async function asCompany<T>(companyId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await testPool().connect();
  try {
    await client.query('begin');
    await client.query('set local role commerio_app');
    await client.query("select set_config('app.company_id', $1, true)", [companyId]);
    return await fn(client);
  } finally {
    await client.query('rollback');
    client.release();
  }
}
