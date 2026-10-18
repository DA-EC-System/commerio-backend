import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import type { Router } from 'express';
import type { Authorize } from './auth/authorize.ts';

/**
 * Thứ một module nhận lúc dựng app, do `src/wiring.ts` dựng: hàm cần từ module khác mà không được import.
 * Module cần thêm trường (vd hàm của module lớp trên) thì khai kiểu tham số `ModuleContext & { … }` trong module mình.
 */
export interface ModuleContext {
  /** `ctx.authorize('catalog.product.manage')`: kiểm đăng nhập, công ty, quyền (src/shared/auth/authorize.ts). */
  readonly authorize: Authorize;
}

/** Mô tả một module cho app.ts: tên (trùng tên schema PostgreSQL) và router HTTP nếu có. */
export interface ModuleDefinition {
  readonly name: string;
  /** Gắn tại /api/v1/<name>. */
  readonly router?: (ctx: ModuleContext) => Router;
  /** Khai đường dẫn cho Swagger, viết tương đối với /api/v1/<name>, cùng schema Zod mà router dùng để kiểm. */
  readonly openapi?: (registry: OpenAPIRegistry) => void;
  /** Việc nền chạy trong tiến trình worker (relay outbox, consumer, tra cứu định kỳ); trả hàm dừng. */
  readonly startBackground?: (ctx: ModuleContext) => Promise<() => Promise<void>>;
}
