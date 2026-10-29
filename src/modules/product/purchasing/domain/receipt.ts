// Luật thuần của phiếu nhận: số thiếu, kiểm số một dòng, đổi cách giao giữa API và DB (spec #109 mục 6.3, 6.7).

export const MAX_REASON = 300;

export interface CountLine {
  /** Số NCC báo giao. */
  announced: number;
  accepted: number;
  defectKept: number;
  returnedOnSpot: number;
  reason: string;
}

/** Thiếu = báo giao − đạt − lỗi giữ − trả tại chỗ (cột `shortage_qty` tự tính cùng công thức). */
export function shortOf(l: Omit<CountLine, 'reason'>): number {
  return l.announced - l.accepted - l.defectKept - l.returnedOnSpot;
}

/** Lỗi theo ô của dòng thứ `i` (câu như mock FE). Số nguyên và khoảng giá trị do schema Zod kiểm. */
export function countErrors(l: CountLine, i: number): Record<string, string> {
  const errors: Record<string, string> = {};
  const short = shortOf(l);
  if (short < 0) errors[`lines.${i}.accepted`] = 'Nhận đạt, lỗi giữ, trả tại chỗ cộng lại vượt số báo giao';
  if ((short > 0 || l.defectKept > 0 || l.returnedOnSpot > 0) && !l.reason.trim()) {
    errors[`lines.${i}.reason`] = 'Ghi lý do khi có thiếu, lỗi hoặc trả tại chỗ';
  }
  return errors;
}

/** API dùng giá trị của FE, DB giữ của Documents/19 (spec #109 mục 2). */
const DB_MODE = { waiting: 'driver_waiting', left: 'driver_left' } as const;
export type DeliveryMode = keyof typeof DB_MODE;
export type DbDeliveryMode = (typeof DB_MODE)[DeliveryMode];

export const toDbMode = (m: DeliveryMode): DbDeliveryMode => DB_MODE[m];
export const fromDbMode = (m: DbDeliveryMode): DeliveryMode => (m === 'driver_left' ? 'left' : 'waiting');
