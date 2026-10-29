// Thao tác đơn trên sàn cho `order` (#105 PR 2): `order` (lớp dưới) nhận các hàm này qua `ctx.marketplaceOrders`
// ở `src/wiring.ts`, không import channel. Gọi sàn ngoài giao dịch nghiệp vụ; lỗi sàn đổi sang mã app (§1.1 R8, R9).
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { onMarketplace, shopSession } from './shops.ts';

const unsupported = () => new AppError(422, 'marketplace_unsupported', 'Sàn này chưa hỗ trợ huỷ đơn từ app');

async function session(companyId: string, shopId: string) {
  return withCompany(companyId, () => shopSession(shopId));
}

export async function marketplaceCancelReasons(
  companyId: string,
  shopId: string,
  externalOrderId: string,
  externalLineIds: readonly string[],
): Promise<{ id: string; label: string }[]> {
  const { adapter, accessToken } = await session(companyId, shopId);
  if (!adapter.cancelReasons) throw unsupported();
  return onMarketplace(() => adapter.cancelReasons!(accessToken, externalOrderId, externalLineIds));
}

export async function marketplaceCancelOrder(
  companyId: string,
  shopId: string,
  externalOrderId: string,
  externalLineIds: readonly string[],
  reasonId: string,
): Promise<void> {
  const { adapter, accessToken } = await session(companyId, shopId);
  if (!adapter.cancelOrder) throw unsupported();
  await onMarketplace(() => adapter.cancelOrder!(accessToken, externalOrderId, externalLineIds, reasonId));
}

export async function marketplaceDecideCancel(companyId: string, shopId: string, externalOrderId: string, accept: boolean): Promise<void> {
  const { adapter, accessToken } = await session(companyId, shopId);
  if (!adapter.decideCancelRequest) throw unsupported();
  await onMarketplace(() => adapter.decideCancelRequest!(accessToken, externalOrderId, accept));
}
