// Cổng quyết toán cho finance (#117): finance (lớp dưới) nhận các hàm này qua `ctx.settlementSource` (`src/wiring.ts`),
// không import channel. Gọi sàn bằng token của gian hàng; chỉ đọc, không ghi gì vào channel. Chỉ việc nền
// `finance.settlement_run` gọi nên lời gọi sàn tính như việc nền (tới 100% phần của công ty, #215).
import { currentCompanyId, withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { findActiveShopsAnyCompany, findShopRow } from '../repository/shops.ts';
import { getAdapter, inBackground, type Payout, type SettlementTxn } from './marketplaces/index.ts';
import { onMarketplace, shopSession } from './shops.ts';

const unsupported = () => new AppError(422, 'marketplace_unsupported', 'Sàn này chưa hỗ trợ lấy sao kê sàn');

/**
 * Sàn trả số tiền không đọc được (#349) là lỗi của hệ thống: ghi `error` kèm trường, chứng từ, giá trị gốc cho kỹ thuật
 * (người dùng chỉ thấy câu cố định của `marketplace_invalid_amount`), rồi ném lại nguyên lỗi.
 */
function reportInvalidAmount(companyId: string, shopId: string) {
  return (err: unknown): never => {
    if (err instanceof AppError && err.code === 'marketplace_invalid_amount') {
      logger.error({ companyId, shopId, platformMessage: err.extensions?.platformMessage }, 'Sàn trả số tiền quyết toán không đọc được');
    }
    throw err;
  };
}

/** Khoản tiền theo đơn trong `[from, to]` của một gian hàng. Gọi ngoài giao dịch nghiệp vụ (gọi mạng). */
export async function settlementTransactions(companyId: string, shopId: string, from: string, to: string): Promise<SettlementTxn[]> {
  return inBackground(async () => {
    const { adapter, accessToken } = await withCompany(companyId, () => shopSession(shopId));
    if (!adapter.getTransactions) throw unsupported();
    return onMarketplace(() => adapter.getTransactions!(accessToken, from, to)).catch(reportInvalidAmount(companyId, shopId));
  });
}

/** Các kỳ quyết toán từ ngày `from` của một gian hàng. */
export async function settlementPayouts(companyId: string, shopId: string, from: string): Promise<Payout[]> {
  return inBackground(async () => {
    const { adapter, accessToken } = await withCompany(companyId, () => shopSession(shopId));
    if (!adapter.getPayouts) return [];
    return onMarketplace(() => adapter.getPayouts!(accessToken, from)).catch(reportInvalidAmount(companyId, shopId));
  });
}

/** Sàn kéo được quyết toán: adapter có `getTransactions` (#401; TikTok chưa có tới #252). */
const settlesOn = (platform: string) => Boolean(getAdapter(platform)?.getTransactions);

/**
 * Gian hàng đang hoạt động của mọi công ty mà sàn kéo được quyết toán, cho việc nền. Gian hàng của sàn chưa hỗ trợ
 * không có ở đây, để vòng kéo không mở lần chạy chắc chắn lỗi (#401). Gọi ngoài `withCompany`.
 */
export async function shopsToSettle(): Promise<{ companyId: string; shopId: string }[]> {
  if (currentCompanyId()) throw new Error('shopsToSettle gọi ngoài withCompany (đọc mọi công ty)');
  return (await findActiveShopsAnyCompany()).filter((s) => settlesOn(s.platform)).map((s) => ({ companyId: s.companyId, shopId: s.id }));
}

/**
 * Gian hàng của công ty có kéo được quyết toán không (#401): finance hỏi trước khi mở lần chạy, để nút Kéo quyết toán
 * báo `marketplace_unsupported` ngay thay vì để việc nền lỗi. Không gọi sàn; gian hàng không thấy thì `false`.
 */
export async function settlementSupported(companyId: string, shopId: string): Promise<boolean> {
  const shop = await withCompany(companyId, () => findShopRow(shopId));
  return Boolean(shop && settlesOn(shop.platform));
}
