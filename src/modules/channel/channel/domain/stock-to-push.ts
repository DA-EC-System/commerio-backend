// Số tồn lần đẩy tới sẽ gửi cho một listing (25 §6.4, §6.5; Documents/21 §18.3 `match-preview`, §18.9 R3). Hàm thuần dùng
// chung cho việc đẩy tồn (`pushDue`), hộp ghép xem trước và cột "Tồn sẽ đẩy" của `ListingRow`, để số hiện ra bằng số gửi lên.

/** Lý do chưa đẩy tồn: gian hàng chờ kiểm kê lần đầu (hoặc chờ phân hàng) thắng SKU kho chưa có số. */
export type StockHeldReason = 'shop_waiting_opening' | 'not_counted';

export interface StockToPushInput {
  /** Listing ẩn bằng tồn 0 (`hidden_by = 'zero_stock'`): luôn gửi 0, kể cả khi gian hàng giữ tồn hay SKU chưa có số. */
  zeroHidden: boolean;
  /** Gian hàng giữ tồn (`holdsStock`): chờ kiểm kê đầu kỳ hoặc chờ phân hàng. */
  holdStock: boolean;
  /** SKU kho đã có số (`countedOf` của inventory, #460). */
  counted: boolean;
  /** Số có thể bán của biến thể; `undefined` khi không đọc được (biến thể không có trong Map). */
  available: number | undefined;
}

export interface StockToPush {
  /** `null` khi lần đẩy tới không gửi tồn. */
  stockToPush: number | null;
  stockHeldReason: StockHeldReason | null;
}

export function stockToPushOf({ zeroHidden, holdStock, counted, available }: StockToPushInput): StockToPush {
  if (zeroHidden) return { stockToPush: 0, stockHeldReason: null };
  if (holdStock) return { stockToPush: null, stockHeldReason: 'shop_waiting_opening' };
  // Không đọc được số có thể bán: `pushDue` ghi `variant_missing`, không phải lý do giữ của hợp đồng.
  if (available === undefined) return { stockToPush: null, stockHeldReason: null };
  if (!counted) return { stockToPush: null, stockHeldReason: 'not_counted' };
  return { stockToPush: available, stockHeldReason: null };
}
