import type { RequestHandler, Response } from 'express';
import { anyOf, getAccess, moduleOfPermission } from '../../../../shared/auth/authorize.ts';
import type { ModuleContext } from '../../../../shared/module.ts';

/** Xem sổ tiền, trạng thái tiền, đối soát, cấu hình tiền (Documents/21 §21.0): có ít nhất một quyền tiền, như mục 16.1. */
export function financeView(ctx: ModuleContext): RequestHandler {
  return anyOf(
    ctx.authorize('finance.config.manage'),
    ctx.authorize('finance.config.approve'),
    ctx.authorize('finance.settlement.resolve'),
    ctx.authorize('finance.settlement.approve'),
    ctx.authorize('finance.invoice.view'),
  );
}

/** Người gọi xem được giá vốn (R4): có `inventory.cost.view` và phân hệ của quyền đó đang bật. Gọi sau `authorize`. */
export function canSeeCost(res: Response): boolean {
  const { permissions, enabledModules } = getAccess(res);
  return permissions.includes('inventory.cost.view') && enabledModules.includes(moduleOfPermission('inventory.cost.view'));
}
