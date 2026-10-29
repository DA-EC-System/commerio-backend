import { Router } from 'express';
import type { ModuleContext } from '../../../../shared/module.ts';

/** Route của module `fulfillment`, gắn tại /api/v1/fulfillment. Kiểm quyền bằng `ctx.authorize(...)`. */
export function fulfillmentRouter(_ctx: ModuleContext): Router {
  return Router();
}
