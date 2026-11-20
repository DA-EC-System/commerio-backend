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
  async decide(companyId, shopId, externalReturnId, externalLineIds, decision, { images = [], ...opts }) {
    const { adapter, accessToken } = await session(companyId, shopId);
    if (!adapter.decideReturn) throw unsupported();
    // Ảnh minh chứng (#437): đưa từng ảnh lên sàn ngay bằng link ký sẵn (hết hạn 15 phút, không lưu), gửi chuỗi sàn trả.
    // Sàn chưa nhận ảnh qua app (không khai `returnImageTypes`) thì bỏ ảnh, như trước #437.
    const types = adapter.returnImageTypes;
    const sent = types ? images : [];
    const wrong = sent.find((i) => !types!.includes(i.contentType.toLowerCase()));
    if (wrong) {
      throw new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', {
        errors: { attachmentIds: `Sàn chỉ nhận ảnh JPG, PNG làm minh chứng: "${wrong.name}" không đúng kiểu` },
      });
    }
    const platformImages: string[] = [];
    for (const image of sent) platformImages.push(await onMarketplace(() => adapter.uploadImage(accessToken, image.url)));
    const withImages = platformImages.length ? { ...opts, images: sent.map((i, n) => ({ name: i.name, url: platformImages[n]! })) } : opts;
    await onMarketplace(() => adapter.decideReturn!(accessToken, externalReturnId, externalLineIds, decision, withImages));
    return { platformImages };
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
