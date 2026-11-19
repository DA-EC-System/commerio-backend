// Phần của finance khi xoá gian hàng đã ngắt (#398): channel gọi trong giao dịch xoá, `withCompany` của nó.
import { paymentRowsOfOrders } from '../../payment/index.ts';
import { countShopFinanceRows, deleteShopFinanceRows } from '../repository/shop-purge.ts';

/** Số dòng tiền của gian hàng theo nhóm; nhóm nào > 0 thì không xoá được gian hàng (409 `shop_has_finance_data`). */
export interface FinanceDataCounts {
  ledgerEntries: number;
  ledgerPackageLines: number;
  settlementStatements: number;
  settlementBatches: number;
  orderSettlements: number;
  /** Hoá đơn, phiếu thu, phiếu chi của đơn gian hàng. */
  documents: number;
  /** Trạng thái tiền, mã thanh toán, giao dịch cổng của đơn gian hàng. */
  payments: number;
}

/**
 * Đếm dữ liệu tiền theo `shop_id` hoặc đơn của gian hàng (đọc, không khoá). Sổ tiền chỉ thêm, `commerio_app` không xoá
 * được, nên gian hàng có dữ liệu tiền thì không xoá (MVP, Khang chốt 18/11/2026).
 */
export async function shopFinanceData(shopId: string, orderIds: readonly string[]): Promise<FinanceDataCounts> {
  return { ...(await countShopFinanceRows(shopId, orderIds)), payments: await paymentRowsOfOrders(orderIds) };
}

export const hasFinanceData = (c: FinanceDataCounts): boolean => Object.values(c).some((n) => n > 0);

/** Xoá đối soát `none` và cấu hình phí của gian hàng; gọi sau khi `shopFinanceData` không còn dòng tiền. */
export function purgeShopFinance(shopId: string, orderIds: readonly string[]): Promise<{ orderSettlements: number; configVersions: number }> {
  return deleteShopFinanceRows(shopId, orderIds);
}
