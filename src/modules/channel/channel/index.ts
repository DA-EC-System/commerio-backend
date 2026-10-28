// API công khai của module `channel`: gian hàng sàn, token, ghép SKU, dữ liệu gốc sàn. Không đổi tồn.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../../shared/module.ts';
import { registerChannelOpenApi } from './api/openapi.ts';
import { channelRouter } from './api/routes.ts';

export const channelModule: ModuleDefinition = {
  name: 'channel',
  router: channelRouter,
  openapi: registerChannelOpenApi,
};

export { getShops, type ShopRef } from './service/shops-lookup.ts';
// Cho #102 (làm mới token thất bại), #133 (sàn báo gỡ app): gọi trong `withCompany`.
export { markNeedsReauth } from './service/shops.ts';
