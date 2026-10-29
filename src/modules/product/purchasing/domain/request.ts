// Luật thuần của đề nghị nhập (Documents/25 §3.1, Documents/21 mục 16).
import { Decimal } from 'decimal.js';
import { moduleOfPermission } from '../../../../shared/auth/company-access.ts';

export const MAX_QTY = 1_000_000;
export const MAX_UNIT_COST = 1_000_000_000;
export const MAX_LINES = 100;

/** Còn chờ = đặt − nhận − lỗi giữ − đóng thiếu; dòng bị CEO loại không còn chờ gì. */
export function outstanding(line: {
  excluded: boolean;
  orderedQty: number;
  receivedQty: number;
  defectiveQty: number;
  closedShortQty: number;
}): number {
  if (line.excluded) return 0;
  return Math.max(0, line.orderedQty - line.receivedQty - line.defectiveQty - line.closedShortQty);
}

/** Số chứng từ người đọc: `DN-000001`. */
export const docNumber = (prefix: string, n: number) => `${prefix}-${String(n).padStart(6, '0')}`;

/** Trạng thái kinh doanh của SKU còn nhập được (FE `purchasable`): đang bán hoặc tạm ngừng. */
export const purchasable = (status: string) => status === 'selling' || status === 'paused';

/** Quyền có hiệu lực: có trong vai trò và phân hệ của quyền đang bật (Documents/21 mục 8). */
export function hasPermission(access: { permissions: readonly string[]; enabledModules: readonly string[] }, code: string) {
  return access.permissions.includes(code) && access.enabledModules.includes(moduleOfPermission(code));
}

/** Thấy giá nhập: người xem giá vốn, người lập hoặc duyệt đề nghị (như mock FE `canSeeCost`). */
export function canSeeCost(access: { permissions: readonly string[]; enabledModules: readonly string[] }): boolean {
  return ['inventory.cost.view', 'purchasing.request.manage', 'purchasing.request.approve'].some((p) => hasPermission(access, p));
}

/** Tiền ra API là số nguyên đồng, làm tròn nửa lên (Documents/21 R2, V29). */
export function toDong(value: Decimal.Value): number {
  return new Decimal(value).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
}
