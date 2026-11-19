import { withCompany } from '../../../../shared/db/client.ts';
import type { PlatformWarehouse } from './marketplaces/index.ts';
import { onMarketplace, shopSession } from './shops.ts';

/**
 * Kho của gian hàng trên sàn (#430, `GET /shops/:id/warehouses`): mọi kho sàn trả, đánh dấu kho app quản. Gọi sàn ngoài
 * giao dịch. Adapter không có `listWarehouses` (TikTok: một kho bán) thì `items: []`.
 */
export async function shopWarehouses(companyId: string, shopId: string): Promise<{ items: PlatformWarehouse[] }> {
  const { adapter, accessToken } = await withCompany(companyId, () => shopSession(shopId));
  if (!adapter.listWarehouses) return { items: [] };
  return { items: await onMarketplace(() => adapter.listWarehouses!(accessToken)) };
}
