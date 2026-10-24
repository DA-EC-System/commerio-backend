import { Router } from 'express';
import type { ModuleContext } from '../../../../shared/module.ts';

/** Route của module `pricing`, gắn tại /api/v1/pricing. Kiểm quyền bằng `ctx.authorize(...)`. */
export function pricingRouter(_ctx: ModuleContext): Router {
  return Router();
}
