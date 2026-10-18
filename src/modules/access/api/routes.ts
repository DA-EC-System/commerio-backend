import { Router } from 'express';
import type { ModuleContext } from '../../../shared/module.ts';

/** Route của module `access` (vai trò, quyền), gắn dưới /api/v1/identity (Documents/21 mục 3). Kiểm quyền bằng `ctx.authorize(...)`. */
export function accessRouter(_ctx: ModuleContext): Router {
  return Router();
}
