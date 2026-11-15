// Luật chia hạn mức gọi sàn theo công ty (#215, Documents/21 §18.6.8). Hàm thuần; đếm ở `repository/api-usage.ts`.

/** Thao tác bấm tay chỉ dùng tới 90% phần của công ty, phần còn lại để dành cho việc nền. */
export const MANUAL_SHARE = 0.9;

/**
 * Phần của công ty trong ngày: `max(companyMin, limit × gian hàng active của công ty / tổng gian hàng active trên sàn)`,
 * làm tròn xuống. Sàn chưa có gian hàng active nào thì là `companyMin`.
 */
export function companyShare(limit: number, companyMin: number, companyShops: number, totalShops: number): number {
  const proportional = totalShops > 0 ? Math.floor((limit * companyShops) / totalShops) : 0;
  return Math.max(companyMin, proportional);
}

/**
 * Số lượt công ty được dùng trong ngày: việc nền tới hết phần, bấm tay tới 90% (được gọi khi đã dùng dưới 90% phần,
 * nên trần là `ceil(0,9 × phần)`).
 */
export function companyCap(share: number, background: boolean): number {
  return background ? share : Math.ceil(share * MANUAL_SHARE);
}
