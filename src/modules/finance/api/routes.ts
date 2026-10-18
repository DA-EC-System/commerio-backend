import { Router } from 'express';
import type { ModuleContext } from '../../../shared/module.ts';

/** Route của module `finance`, gắn tại /api/v1/finance. Kiểm quyền bằng `ctx.authorize(...)`. */
export function financeRouter(_ctx: ModuleContext): Router {
  return Router();
}
