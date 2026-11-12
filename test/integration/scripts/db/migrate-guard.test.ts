import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { inspect, MigrationOrderError, migrateGuarded } from '../../../../scripts/db/lib/guard.ts';
import { cleanupFakeDirs, fakeMigrations, writeJournal, writeSnapshot } from '../../../unit/scripts/db/lib/fake-migrations.ts';

// Chạy trên Postgres của lượt test, nhưng bảng migration và bảng dữ liệu nằm ở schema riêng của mỗi test, không đụng
// drizzle.__drizzle_migrations thật.
let client: pg.Client;
const schemas: string[] = [];

beforeAll(async () => {
  client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
});

afterEach(async () => {
  cleanupFakeDirs();
  for (const s of schemas.splice(0)) await client.query(`drop schema if exists "${s}" cascade`);
});

afterAll(async () => {
  await client.end();
});

function scenario() {
  const id = randomUUID().slice(0, 8);
  const data = `mg_data_${id}`;
  const meta = `mg_meta_${id}`;
  schemas.push(data, meta);
  const A = { tag: '20261101000000_a', when: 1000, sql: `create schema "${data}";--> statement-breakpoint\ncreate table "${data}".a (id int);` };
  const B = { tag: '20261102000000_b', when: 2000, sql: `create table "${data}".b (id int);` };
  const C = { tag: '20261103000000_c', when: 3000, sql: `create table "${data}".c (id int);` };
  const opts = { migrationsSchema: meta, migrationsTable: '__drizzle_migrations', log: () => undefined };
  const tables = async (): Promise<string[]> => {
    const { rows } = await client.query<{ t: string }>('select table_name as t from information_schema.tables where table_schema = $1 order by 1', [data]);
    return rows.map((r) => r.t);
  };
  /** Nhánh khác: B sinh lúc 2000 nhưng merge sau C (3000). */
  const addLateB = (dir: string): void => {
    writeFileSync(join(dir, `${B.tag}.sql`), B.sql);
    writeSnapshot(dir, B.tag, { id: 'id-b', prevId: `id-${C.tag}`, tables: {} });
    writeJournal(dir, [A, C, B]);
  };
  return { A, B, C, opts, tables, addLateB };
}

describe('db:migrate có chặn migration lệch thứ tự', () => {
  it('drizzle gốc bỏ qua im lặng migration sinh trước nhưng merge sau (bằng chứng cho lỗi cần chặn)', async () => {
    const { A, C, opts, tables, addLateB } = scenario();
    const dir = fakeMigrations([A, C]);
    const config = { migrationsFolder: dir, migrationsSchema: opts.migrationsSchema, migrationsTable: opts.migrationsTable };
    await migrate(drizzle({ client }), config);
    addLateB(dir);
    await migrate(drizzle({ client }), config);
    expect(await tables()).toEqual(['a', 'c']);
  });

  it('chạy migration chưa chạy như drizzle khi không có gì lệch', async () => {
    const { A, B, C, opts, tables } = scenario();
    const dir = fakeMigrations([A, B]);
    await migrateGuarded(client, { ...opts, migrationsFolder: dir });
    writeFileSync(join(dir, `${C.tag}.sql`), C.sql);
    writeSnapshot(dir, C.tag, { id: 'id-c', prevId: `id-${B.tag}`, tables: {} });
    writeJournal(dir, [A, B, C]);
    const status = await migrateGuarded(client, { ...opts, migrationsFolder: dir });
    expect(status.applied.map((m) => m.tag)).toEqual([A.tag, B.tag, C.tag]);
    expect(await tables()).toEqual(['a', 'b', 'c']);
  });

  it('dừng với lỗi, ghi tên file, không chạy gì khi có migration lệch thứ tự', async () => {
    const { A, B, C, opts, tables, addLateB } = scenario();
    const dir = fakeMigrations([A, C]);
    await migrateGuarded(client, { ...opts, migrationsFolder: dir });
    addLateB(dir);
    const error = await migrateGuarded(client, { ...opts, migrationsFolder: dir }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MigrationOrderError);
    expect((error as Error).message).toContain(`db/migrations/${B.tag}.sql`);
    expect(await tables()).toEqual(['a', 'c']);
  });

  it('phát hiện migration đã bị drizzle bỏ qua từ trước (DB như staging): kiểm chỉ đọc liệt kê, migrate dừng', async () => {
    const { A, B, C, opts, addLateB } = scenario();
    const dir = fakeMigrations([A, C]);
    const config = { migrationsFolder: dir, migrationsSchema: opts.migrationsSchema, migrationsTable: opts.migrationsTable };
    await migrate(drizzle({ client }), config);
    addLateB(dir);
    await migrate(drizzle({ client }), config); // bỏ qua B im lặng như drizzle-kit migrate cũ

    const status = await inspect(client, { ...opts, migrationsFolder: dir });
    expect(status.applied.map((m) => m.tag)).toEqual([A.tag, C.tag]);
    expect(status.outOfOrder.map((m) => m.tag)).toEqual([B.tag]);
    await expect(migrateGuarded(client, { ...opts, migrationsFolder: dir })).rejects.toBeInstanceOf(MigrationOrderError);
  });

  it('dev chạy migration của nhánh lên DB local rồi db:regen: bản chép lại là chưa chạy (drizzle sẽ chạy lại), có cảnh báo', async () => {
    const { A, C, opts } = scenario();
    const dir = fakeMigrations([A, C]);
    await migrateGuarded(client, { ...opts, migrationsFolder: dir });
    // db:regen chép nguyên C sang tên mới, when mới: cùng hash, khác when.
    const C2 = { tag: '20261109000000_c', when: 9000, sql: C.sql };
    writeFileSync(join(dir, `${C2.tag}.sql`), C2.sql);
    writeSnapshot(dir, C2.tag, { id: 'id-c2', prevId: `id-${A.tag}`, tables: {} });
    writeJournal(dir, [A, C2]);
    const status = await inspect(client, { ...opts, migrationsFolder: dir });
    expect(status.pending.map((m) => m.tag)).toEqual([C2.tag]);
    expect(status.sameHashOtherWhen.map((m) => m.tag)).toEqual([C2.tag]);
    expect(status.unknownRows).toHaveLength(1);
  });

  it('dòng chèn tay thiếu created_at thì migrate dừng, không chạy gì', async () => {
    const { A, B, opts, tables } = scenario();
    const dir = fakeMigrations([A]);
    await migrateGuarded(client, { ...opts, migrationsFolder: dir });
    await client.query(`insert into "${opts.migrationsSchema}"."__drizzle_migrations" (hash) values ('chen-tay')`);
    writeFileSync(join(dir, `${B.tag}.sql`), B.sql);
    writeSnapshot(dir, B.tag, { id: 'id-b', prevId: `id-${A.tag}`, tables: {} });
    writeJournal(dir, [A, B]);
    const error = await migrateGuarded(client, { ...opts, migrationsFolder: dir }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MigrationOrderError);
    expect((error as Error).message).toContain('thiếu created_at');
    expect(await tables()).toEqual(['a']);
  });

  it('kiểm chỉ đọc không tạo bảng migration trên DB chưa migrate', async () => {
    const { A, opts } = scenario();
    const dir = fakeMigrations([A]);
    const status = await inspect(client, { ...opts, migrationsFolder: dir });
    expect(status.pending.map((m) => m.tag)).toEqual([A.tag]);
    const { rows } = await client.query('select 1 from information_schema.schemata where schema_name = $1', [opts.migrationsSchema]);
    expect(rows).toEqual([]);
  });
});
