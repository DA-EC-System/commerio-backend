import { Router } from 'express';
import type { ModuleContext } from '../../../shared/module.ts';

/** Route của module `inventory`, gắn tại /api/v1/inventory. Kiểm quyền bằng `ctx.authorize(...)`. */
export function inventoryRouter(_ctx: ModuleContext): Router {
  return Router();
}
