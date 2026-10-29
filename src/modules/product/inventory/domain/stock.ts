// Luật thuần của kho: giá vốn bình quân (Documents/21 K2), làm tròn (V29, V30), ngưỡng tồn (K7, V31), số phiếu (V32).
import { Decimal } from 'decimal.js';

/** Giá vốn sau khi nhập `qty` cái giá `unitCost`: bình quân gia quyền, làm tròn nửa lên 2 chữ số như `numeric(18,2)`. */
export function weightedAvgCost(onHand: number, avgCost: Decimal.Value, qty: number, unitCost: Decimal.Value): Decimal {
  if (!Number.isInteger(qty) || qty <= 0) throw new Error(`Số lượng nhập phải là số nguyên dương: ${qty}`);
  const total = new Decimal(avgCost).times(onHand).plus(new Decimal(unitCost).times(qty));
  return total.div(onHand + qty).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** Tiền ra API là số nguyên đồng, làm tròn nửa lên (V29). */
export function toDong(value: Decimal.Value): number {
  return new Decimal(value).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
}

/** Giá trị tồn = `onHand × avg_cost` (giá vốn 2 chữ số của DB) rồi mới làm tròn đồng (V30, plan #16 A4). */
export function stockValue(onHand: number, avgCost: Decimal.Value): number {
  return toDong(new Decimal(avgCost).times(onHand));
}

/** Khả dụng = `max(0, tồn thực − đang giữ − tạm khoá)`, số đẩy lên sàn (Documents/21 mục 15.1). */
export function availableQty(onHand: number, reserved: number, locked: number): number {
  return Math.max(0, onHand - reserved - locked);
}

/** Khả dụng dưới ngưỡng; chưa đặt ngưỡng thì không bao giờ dưới (K7). */
export function isBelowMin(available: number, minQty: number | null): boolean {
  return minQty !== null && available < minQty;
}

/** Nhãn tồn của dòng (Documents/21 mục 15.1): hết hàng khi khả dụng ≤ 0, sắp hết khi dưới ngưỡng (K7). */
export function stockState(available: number, minQty: number | null): 'in_stock' | 'low' | 'out' {
  if (available <= 0) return 'out';
  return isBelowMin(available, minQty) ? 'low' : 'in_stock';
}

/**
 * Cảnh báo dưới ngưỡng phát một lần khi vừa xuống dưới (`alertActive` false → true); lên lại ≥ ngưỡng hoặc bỏ
 * ngưỡng thì tắt để lần xuống sau phát lại (V31).
 */
export function nextAlertState(state: { available: number; minQty: number | null; alertActive: boolean }): {
  alertActive: boolean;
  fire: boolean;
} {
  const below = isBelowMin(state.available, state.minQty);
  return { alertActive: below, fire: below && !state.alertActive };
}
