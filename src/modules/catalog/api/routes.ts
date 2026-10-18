import { Router } from 'express';
import type { CatalogContext } from '../service/standard-price.ts';

/**
 * Route của module `catalog`, gắn tại /api/v1/catalog. Kiểm quyền bằng `ctx.authorize(...)`;
 * giá chuẩn của chi tiết sản phẩm lấy bằng `standardPricesOf(ctx, …)`.
 */
export function catalogRouter(_ctx: CatalogContext): Router {
  return Router();
}
