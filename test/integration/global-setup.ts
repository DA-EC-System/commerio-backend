import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

// Role chạy migration giống user `postgres` của Supabase: không superuser, có CREATEROLE (db/CLAUDE.md).
const MIGRATOR = 'commerio_migrator';

// Một container cho cả lượt test, cùng ảnh với deploy/compose.yaml; chạy đúng các file migration thật.
// Staging là PostgreSQL 17: chạy thử bằng TEST_PG_IMAGE=pgvector/pgvector:pg17 npm test.
export async function setup(project: TestProject): Promise<void> {
  container = await new PostgreSqlContainer(process.env.TEST_PG_IMAGE ?? 'pgvector/pgvector:pg18').start();
  const admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await admin.query(`create role ${MIGRATOR} login password '${MIGRATOR}' nosuperuser createrole`);
  await admin.query(`grant create on database "${container.getDatabase()}" to ${MIGRATOR}`);
  // pgvector cần superuser (xem migration 0012).
  await admin.query('create extension if not exists vector');
  await admin.end();

  const url = new URL(container.getConnectionUri());
  url.username = MIGRATOR;
  url.password = MIGRATOR;
  const pool = new pg.Pool({ connectionString: url.toString() });
  await migrate(drizzle({ client: pool }), { migrationsFolder: 'db/migrations' });
  await pool.end();
  project.provide('databaseUrl', url.toString());
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
