import { Router } from 'express';
import type { ModuleContext } from '../../../../shared/module.ts';

/** Route của module `channel`, gắn tại /api/v1/channel. Kiểm quyền bằng `ctx.authorize(...)`. */
export function channelRouter(_ctx: ModuleContext): Router {
  return Router();
}
