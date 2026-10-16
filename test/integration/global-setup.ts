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

// Một container cho cả lượt test, cùng ảnh với deploy/compose.yaml; chạy đúng các file migration thật.
export async function setup(project: TestProject): Promise<void> {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg18').start();
  const url = container.getConnectionUri();
  const pool = new pg.Pool({ connectionString: url });
  await migrate(drizzle({ client: pool }), { migrationsFolder: 'db/migrations' });
  await pool.end();
  project.provide('databaseUrl', url);
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
