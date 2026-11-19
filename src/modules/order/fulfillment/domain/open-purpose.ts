// Mục đích của cờ Cần mở trên kiện đã đóng (spec #238 §5.5; spec 237 §5.6, D17, D18). Thuần, không I/O.

/**
 * Vì sao kiện đã đóng chờ mở: `cancel` (đơn huỷ), `edit`, `resplit` (sàn chia lại kiện), `stocktake` (phiếu kiểm kê đếm
 * thấp hơn hàng trong kiện, spec #238 §5.5), `remap` (đổi ghép SKU: món trong hộp theo ghép cũ, spec 237 §5.6). Giá trị
 * mới thêm bằng migration riêng: PostgreSQL không cho dùng giá trị enum mới trong chính giao dịch thêm nó.
 */
export const OPEN_PURPOSES = ['cancel', 'edit', 'resplit', 'stocktake', 'remap'] as const;
export type OpenPurpose = (typeof OPEN_PURPOSES)[number];
