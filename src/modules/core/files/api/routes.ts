import { Router } from 'express';
import type { ModuleContext } from '../../../../shared/module.ts';

/** Route của module `files`, gắn tại /api/v1/files. Kiểm quyền bằng `ctx.authorize(...)`. */
export function filesRouter(_ctx: ModuleContext): Router {
  return Router();
}
