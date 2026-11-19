// Một lần chuyển trạng thái gian hàng: lịch sử (`core.state_transitions`) và `channel.shop_status_changed` cho realtime
// (Documents/21 §13.2, #216) trong cùng giao dịch. Mọi chỗ đổi `shops.status` gọi hàm này, không gọi `recordTransition` riêng.
import { publishEvent, recordTransition } from '../../../core/index.ts';
import type { ShopAction, ShopStatus } from '../domain/shop.ts';

export async function recordShopTransition(input: {
  shopId: string;
  from: ShopStatus | null;
  to: ShopStatus;
  action: ShopAction | 'connect';
  actorId: string | null;
  reason?: string | null;
}): Promise<void> {
  const { shopId, from, to, action, actorId, reason } = input;
  await recordTransition({ entityType: 'shops', entityId: shopId, from, to, action, actorId, ...(reason !== undefined && { reason }) });
  await publishEvent({ type: 'channel.shop_status_changed', aggregateId: shopId, payload: { shopId, from, to } });
}
