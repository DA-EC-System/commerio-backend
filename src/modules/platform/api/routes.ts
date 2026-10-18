import { Router } from 'express';
import type { ModuleContext } from '../../../shared/module.ts';

/** Route của module `platform`, gắn tại /api/v1/platform. Kiểm quyền bằng `ctx.authorize(...)`. */
export function platformRouter(_ctx: ModuleContext): Router {
  return Router();
}
