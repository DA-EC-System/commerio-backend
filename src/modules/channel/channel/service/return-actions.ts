// Thao tác yêu cầu trả trên sàn cho `order` (#202): tiêm qua `ctx.marketplaceReturns` ở `src/wiring.ts`, như
// `order-actions.ts`. Gọi sàn ngoài giao dịch nghiệp vụ; lỗi sàn đổi sang mã app (§1.1 R8, R9).
import type { MarketplaceReturns } from '../../../order/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { findShopRow } from '../repository/shops.ts';
import { getAdapter } from './marketplaces/index.ts';
import { onMarketplace, shopSession } from './shops.ts';

const unsupported = () => new AppError(422, 'marketplace_unsupported', 'Sàn này chưa hỗ trợ xử lý yêu cầu trả từ app');

async function session(companyId: string, shopId: string) {
  return withCompany(companyId, () => shopSession(shopId));
}

/** Adapter theo sàn của gian hàng, chỉ đọc DB (không giải mã token, không gọi sàn). */
async function platformAdapter(companyId: string, shopId: string) {
  const shop = await withCompany(companyId, () => findShopRow(shopId));
  return shop ? getAdapter(shop.platform) : undefined;
}

export const marketplaceReturns: MarketplaceReturns = {
  async reasons(companyId, shopId, externalReturnId, action) {
    const { adapter, accessToken } = await session(companyId, shopId);
    if (!adapter.returnReasons) throw unsupported();
    return onMarketplace(() => adapter.returnReasons!(accessToken, externalReturnId, action));
  },
  async decide(companyId, shopId, externalReturnId, externalLineIds, decision, opts) {
    const { adapter, accessToken } = await session(companyId, shopId);
    if (!adapter.decideReturn) throw unsupported();
    await onMarketplace(() => adapter.decideReturn!(accessToken, externalReturnId, externalLineIds, decision, opts));
  },
  async confirmReceived(companyId, shopId, externalReturnId, externalLineIds) {
    // Sàn không báo lúc quét (TikTok đồng ý hoàn tiền sau kiểm hàng, #392): không mở phiên, gian hàng đã ngắt không thành lỗi.
    if (!(await platformAdapter(companyId, shopId))?.confirmReturnReceived) return;
    const { adapter, accessToken } = await session(companyId, shopId);
    if (!adapter.confirmReturnReceived) return;
    await onMarketplace(() => adapter.confirmReturnReceived!(accessToken, externalReturnId, externalLineIds));
  },
  async approvesRefundAfterInspection(companyId, shopId) {
    return Boolean((await platformAdapter(companyId, shopId))?.approveReturnRefund);
  },
  async history(companyId, shopId, externalReturnId, externalLineIds) {
    const { adapter, accessToken } = await session(companyId, shopId);
    if (!adapter.returnHistory) throw unsupported();
    const items = await onMarketplace(() => adapter.returnHistory!(accessToken, externalReturnId, externalLineIds));
    return items.map((i) => ({ ...i, at: i.at.toISOString() }));
  },
};
