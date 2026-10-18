import { Router } from 'express';
import type { ModuleContext } from '../../../shared/module.ts';

/** Route của module `staff`, gắn tại /api/v1/staff. Kiểm quyền bằng `ctx.authorize(...)`. */
export function staffRouter(_ctx: ModuleContext): Router {
  return Router();
}
