// Mục đích của cờ Cần mở trên kiện đã đóng (spec #238 §5.5; spec 237 §5.6, D17, D18). Thuần, không I/O.

/**
 * Vì sao kiện đã đóng chờ mở: `cancel` (đơn huỷ), `edit`, `resplit` (sàn chia lại kiện), `stocktake` (phiếu kiểm kê đếm
 * thấp hơn hàng trong kiện, spec #238 §5.5), `remap` (đổi ghép SKU: món trong hộp theo ghép cũ, spec 237 §5.6). Giá trị
 * mới thêm bằng migration riêng: PostgreSQL không cho dùng giá trị enum mới trong chính giao dịch thêm nó.
 */
export const OPEN_PURPOSES = ['cancel', 'edit', 'resplit', 'stocktake', 'remap'] as const;
export type OpenPurpose = (typeof OPEN_PURPOSES)[number];

/** Mục đích bật lên bởi một việc (sàn huỷ cả kiện, sàn chia lại kiện, đổi ghép SKU). */
export type RaisedPurpose = 'cancel' | 'resplit' | 'remap';

/**
 * Mục đích nào thay được mục đích đang có (spec 237 D17): `cancel` > `resplit` > `remap` > `stocktake`; `edit` không bị
 * `remap` thay; `edit`, `stocktake` tự nó không thay mục đích nào (không bật qua hàm này).
 */
const BEATS: Record<RaisedPurpose, readonly OpenPurpose[]> = {
  cancel: ['edit', 'stocktake', 'resplit', 'remap'],
  resplit: ['edit', 'stocktake', 'remap'],
  remap: ['stocktake'],
};

/**
 * Bật Cần mở với mục đích `wanted`: kiện chưa có cờ, hoặc mục đích đang có bị `wanted` thắng, thì trả cột cần ghi; còn
 * lại `null` (giữ mục đích đang có).
 */
export function raisePurpose(
  pkg: { needsOpen: boolean; openPurpose: OpenPurpose | null },
  wanted: RaisedPurpose,
): { needsOpen: true; openPurpose: OpenPurpose } | null {
  if (!pkg.needsOpen || pkg.openPurpose === null || BEATS[wanted].includes(pkg.openPurpose)) return { needsOpen: true, openPurpose: wanted };
  return null;
}

/**
 * Gỡ Cần mở khi kiện vẫn đóng (không qua mở, spec 237 D18): kiện còn dòng có dấu chờ đổi ghép thì đổi mục đích sang
 * `remap` thay vì gỡ, để việc đổi ghép không mất.
 */
export function purposeAfterClear(stillPending: boolean): { needsOpen: false; openPurpose: null } | { openPurpose: 'remap' } {
  return stillPending ? { openPurpose: 'remap' } : { needsOpen: false, openPurpose: null };
}
