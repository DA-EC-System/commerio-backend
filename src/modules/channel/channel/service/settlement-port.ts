// Cổng quyết toán cho finance (#117): finance (lớp dưới) nhận các hàm này qua `ctx.settlementSource` (`src/wiring.ts`),
// không import channel. Gọi sàn bằng token của gian hàng; chỉ đọc, không ghi gì vào channel.
import { currentCompanyId, withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { findActiveShopsAnyCompany } from '../repository/shops.ts';
import type { Payout, SettlementTxn } from './marketplaces/index.ts';
import { onMarketplace, shopSession } from './shops.ts';

const unsupported = () => new AppError(422, 'marketplace_unsupported', 'Sàn này chưa hỗ trợ kéo quyết toán');

/** Khoản tiền theo đơn trong `[from, to]` của một gian hàng. Gọi ngoài giao dịch nghiệp vụ (gọi mạng). */
export async function settlementTransactions(companyId: string, shopId: string, from: string, to: string): Promise<SettlementTxn[]> {
  const { adapter, accessToken } = await withCompany(companyId, () => shopSession(shopId));
  if (!adapter.getTransactions) throw unsupported();
  return onMarketplace(() => adapter.getTransactions!(accessToken, from, to));
}

/** Các kỳ quyết toán từ ngày `from` của một gian hàng. */
export async function settlementPayouts(companyId: string, shopId: string, from: string): Promise<Payout[]> {
  const { adapter, accessToken } = await withCompany(companyId, () => shopSession(shopId));
  if (!adapter.getPayouts) return [];
  return onMarketplace(() => adapter.getPayouts!(accessToken, from));
}

/** Gian hàng đang hoạt động của mọi công ty, cho việc nền. Gọi ngoài `withCompany`. */
export async function shopsToSettle(): Promise<{ companyId: string; shopId: string }[]> {
  if (currentCompanyId()) throw new Error('shopsToSettle gọi ngoài withCompany (đọc mọi công ty)');
  return (await findActiveShopsAnyCompany()).map((s) => ({ companyId: s.companyId, shopId: s.id }));
}
