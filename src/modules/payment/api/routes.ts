import { Router } from 'express';
import type { ModuleContext } from '../../../shared/module.ts';

/** Route của module `payment`, gắn tại /api/v1/payment. Kiểm quyền bằng `ctx.authorize(...)`. */
export function paymentRouter(_ctx: ModuleContext): Router {
  return Router();
}
