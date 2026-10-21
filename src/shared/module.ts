import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import type { Router } from 'express';

/** Mô tả một module cho app.ts: tên (trùng tên schema PostgreSQL) và router HTTP nếu có. */
export interface ModuleDefinition {
  readonly name: string;
  /** Gắn tại /api/v1/<name>. */
  readonly router?: Router;
  /** Khai đường dẫn cho Swagger, viết tương đối với /api/v1/<name>, cùng schema Zod mà router dùng để kiểm. */
  readonly openapi?: (registry: OpenAPIRegistry) => void;
}
