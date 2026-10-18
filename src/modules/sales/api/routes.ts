import { Router } from 'express';
import type { ModuleContext } from '../../../shared/module.ts';

/** Route của module `sales`, gắn tại /api/v1/sales. Kiểm quyền bằng `ctx.authorize(...)`. */
export function salesRouter(_ctx: ModuleContext): Router {
  return Router();
}
