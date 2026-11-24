// Nguồn số đếm của dòng kiểm kê đầu kỳ (#569, Documents/21 §18.6.2 `StockDocLine.countSource`, Documents/19 `count_source`).
// Hàm thuần: không I/O.

export const COUNT_SOURCES = ['manual', 'platform'] as const;
export type CountSource = (typeof COUNT_SOURCES)[number];

/**
 * Nguồn ghi xuống DB cho một dòng lúc lưu. Phiếu không phải đầu kỳ, hoặc dòng chưa đếm: null. FE gửi `platform` mà số đếm khác
 * tồn sàn lúc ghi (bản sao vừa đồng bộ lại, người dùng sửa số) thì ghi `manual`, không báo lỗi. Thiếu thì `manual`.
 */
export function countSourceOf(input: {
  isOpening: boolean;
  counted: number | null;
  requested: CountSource | null | undefined;
  platformStock: number | null;
}): CountSource | null {
  if (!input.isOpening || input.counted === null) return null;
  if (input.requested === 'platform' && input.platformStock !== null && input.counted === input.platformStock) return 'platform';
  return 'manual';
}
