import { Router } from 'express';
import type { ModuleContext } from '../../../shared/module.ts';

/** Route của module `catalog`, gắn tại /api/v1/catalog. Kiểm quyền bằng `ctx.authorize(...)`. */
export function catalogRouter(_ctx: ModuleContext): Router {
  return Router();
}
