// Hàm inventory cho module con khác cùng module lớn `product` (spec #111 mục 5.5). Chạy trong `withCompany` của bên gọi.
import { getVariants } from '../../catalog/index.ts';
import { availableQty } from '../domain/stock.ts';
import { takeNextNumber } from '../repository/counters.ts';
import { levelsOf } from '../repository/levels.ts';
import { lockedOf } from './locked.ts';

export interface StockSnapshot {
  onHand: number;
  reserved: number;
  locked: number;
  available: number;
  quarantine: number;
  /** Giá vốn bình quân, chuỗi `numeric(18,2)`. */
  avgCost: string;
}

/**
 * Các con số của những biến thể thuộc công ty trong `variantIds`; biến thể chưa có dòng tồn trả số 0. Id của công ty
 * khác, không tồn tại hay không phải uuid thì không có trong Map (spec #111 Q3).
 */
export async function stockOf(variantIds: readonly string[]): Promise<Map<string, StockSnapshot>> {
  const variants = await getVariants(variantIds);
  const levels = await levelsOf(variants.map((v) => v.id));
  return new Map(
    variants.map((v) => {
      const level = levels.get(v.id);
      const onHand = level?.onHand ?? 0;
      const reserved = level?.reserved ?? 0;
      const locked = lockedOf(v.id);
      const snapshot: StockSnapshot = {
        onHand,
        reserved,
        locked,
        available: availableQty(onHand, reserved, locked),
        quarantine: level?.quarantine ?? 0,
        avgCost: level?.avgCost ?? '0',
      };
      return [v.id, snapshot];
    }),
  );
}

/**
 * Số khả dụng `max(0, tồn thực − đang giữ − tạm khoá)` của các biến thể thuộc công ty, cùng cách lọc như `stockOf`
 * (spec #111 Q3). Channel đọc số này để đẩy tồn lên sàn.
 */
export async function availableOf(variantIds: readonly string[]): Promise<Map<string, number>> {
  // shortcut: getVariants nạp cả thuộc tính; đổi sang truy vấn chỉ lấy id nếu #104 gọi hàng nghìn id một lần.
  return new Map([...(await stockOf(variantIds))].map(([id, s]) => [id, s.available]));
}

/** Số kế tiếp của một loại chứng từ trong công ty (bắt đầu từ 1); bên gọi tự ghép tiền tố (`DN-000001`). */
export const nextDocNumber = takeNextNumber;

// Cổng tồn theo kiện (Documents/21 mục 11.1, spec #206 mục 5.5): fulfillment và yêu cầu trả gọi trong giao dịch của mình.
export type { DocumentRef, StockLine } from '../domain/documents.ts';
export { release, reserve } from './reservation.ts';
export { receiveBack } from './returns.ts';
export { reverseShipment, type ShipOptions, ship } from './shipment.ts';
