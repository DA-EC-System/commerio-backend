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

/** Khả dụng dưới ngưỡng; chưa đặt ngưỡng thì không bao giờ dưới (K7). */
export function isBelowMin(available: number, minQty: number | null): boolean {
  return minQty !== null && available < minQty;
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

/** `PN-000001` (phiếu nhập), `PX-000001` (phiếu xuất), đánh số riêng mỗi công ty. */
export function docNumber(type: 'receipt' | 'issue', n: number): string {
  return `${type === 'receipt' ? 'PN' : 'PX'}-${String(n).padStart(6, '0')}`;
}

export interface DocLineInput {
  variantId: string;
  quantity: number;
  unitCost?: number | undefined;
}

/**
 * Luật dòng phiếu phụ thuộc loại phiếu (plan #16 A7; câu báo lỗi theo mock FE `validateDocInput`): phiếu nhập cần giá
 * nhập từng dòng, phiếu xuất tay cần lý do, mỗi biến thể một dòng. Giới hạn số kiểm ở schema Zod.
 */
export function docInputErrors(type: 'receipt' | 'issue', note: string, lines: readonly DocLineInput[]): Record<string, string> {
  const errors: Record<string, string> = {};
  if (type === 'issue' && !note.trim()) errors.note = 'Nhập lý do xuất kho';
  const seen = new Set<string>();
  lines.forEach((line, i) => {
    if (seen.has(line.variantId)) errors[`lines.${i}.variantId`] = 'Biến thể bị lặp';
    seen.add(line.variantId);
    if (type === 'receipt' && line.unitCost === undefined) errors[`lines.${i}.unitCost`] = 'Giá nhập là số nguyên đồng, không âm';
  });
  return errors;
}
