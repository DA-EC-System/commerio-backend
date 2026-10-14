import type { Router } from 'express';

/** Mô tả một module cho app.ts: tên (trùng tên schema PostgreSQL) và router HTTP nếu có. */
export interface ModuleDefinition {
  readonly name: string;
  /** Gắn tại /api/v1/<name>. */
  readonly router?: Router;
}
