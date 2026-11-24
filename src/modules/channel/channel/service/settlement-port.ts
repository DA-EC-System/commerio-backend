// Cổng quyết toán cho finance (#117): finance (lớp dưới) nhận các hàm này qua `ctx.settlementSource` (`src/wiring.ts`),
// không import channel. Gọi sàn bằng token của gian hàng; chỉ đọc, không ghi gì vào channel. Chỉ việc nền
// `finance.settlement_run` gọi nên lời gọi sàn tính như việc nền (tới 100% phần của công ty, #215).
import { currentCompanyId, withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { findActiveShopsAnyCompany } from '../repository/shops.ts';
import { type FeeSample, feeSamplesFromLines } from '../../../finance/index.ts';
import { inBackground, type Payout, type SettlementTxn } from './marketplaces/index.ts';
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

/**
 * Mẫu phí theo đơn cho gợi ý cấu hình phí (tra-phi-san.md mục 5b): adapter có `feeSamples` (TikTok: sao kê, bù số ước tính)
 * thì dùng; không thì dựng từ khoản quyết toán trong `[since, hôm nay]` (Lazada `getTransactions`, gom theo đơn), mới nhất
 * trước, tối đa `limit`. Chỉ đọc, không ghi sổ. Gọi ngoài giao dịch nghiệp vụ.
 */
export async function settlementFeeSamples(
  companyId: string,
  shopId: string,
  opts: { limit: number; since: string; until: string },
): Promise<FeeSample[]> {
  return inBackground(async () => {
    const { adapter, accessToken } = await withCompany(companyId, () => shopSession(shopId));
    if (adapter.feeSamples) {
      return onMarketplace(() => adapter.feeSamples!(accessToken, { limit: opts.limit, since: opts.since })).catch(reportInvalidAmount(companyId, shopId));
    }
    if (!adapter.getTransactions) throw unsupported();
    const lines = await onMarketplace(() => adapter.getTransactions!(accessToken, opts.since, opts.until)).catch(reportInvalidAmount(companyId, shopId));
    return feeSamplesFromLines(lines)
      .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1))
      .slice(0, opts.limit);
  });
}

/** Gian hàng đang hoạt động của mọi công ty, cho việc nền. Gọi ngoài `withCompany`. */
export async function shopsToSettle(): Promise<{ companyId: string; shopId: string }[]> {
  if (currentCompanyId()) throw new Error('shopsToSettle gọi ngoài withCompany (đọc mọi công ty)');
  return (await findActiveShopsAnyCompany()).map((s) => ({ companyId: s.companyId, shopId: s.id }));
}
