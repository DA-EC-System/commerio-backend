import { Router } from 'express';
import type { ModuleContext } from '../../../shared/module.ts';

/** Route của module `report`, gắn tại /api/v1/report. Kiểm quyền bằng `ctx.authorize(...)`. */
export function reportRouter(_ctx: ModuleContext): Router {
  return Router();
}
