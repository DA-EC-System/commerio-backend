// Hàm inventory cho module con khác cùng module lớn `product` (spec #111 mục 5.5). Chạy trong `withCompany` của bên gọi.
import { notImplemented } from '../../../../shared/errors/app-error.ts';
import { getVariants } from '../../catalog/index.ts';
import { availableQty } from '../domain/stock.ts';
import { takeNextNumber } from '../repository/counters.ts';
import { pendingLocks } from '../repository/documents.ts';
import { levelsOf } from '../repository/levels.ts';

export interface StockSnapshot {
  onHand: number;
  reserved: number;
  locked: number;
  available: number;
  quarantine: number;
  /** Giá vốn bình quân, chuỗi `numeric(18,2)`. */
  avgCost: string;
}

/** Tạm khoá theo biến thể: phần giảm tồn thực của phiếu kho đang chờ duyệt (#208, Documents/25 §7.1). Không khoá thì vắng. */
export const lockedOf = (variantIds?: readonly string[]): Promise<Map<string, number>> => pendingLocks(variantIds);

/**
 * Các con số của những biến thể thuộc công ty trong `variantIds`; biến thể chưa có dòng tồn trả số 0. Id của công ty
 * khác, không tồn tại hay không phải uuid thì không có trong Map (spec #111 Q3).
 */
export async function stockOf(variantIds: readonly string[]): Promise<Map<string, StockSnapshot>> {
  const variants = await getVariants(variantIds);
  const levels = await levelsOf(variants.map((v) => v.id));
  const locks = await lockedOf(variants.map((v) => v.id));
  return new Map(
    variants.map((v) => {
      const level = levels.get(v.id);
      const onHand = level?.onHand ?? 0;
      const reserved = level?.reserved ?? 0;
      const locked = locks.get(v.id) ?? 0;
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

// Chữ ký cổng theo kiện (Documents/21 mục 11.1), đã chốt để order code theo; thân làm ở commerio-backend#206 (Khang).

export interface StockLine {
  variantId: string;
  quantity: number;
}

/** Giữ hàng cho kiện; `reserved: false` khi không đủ khả dụng. */
export function reserve(_packageId: string, _lines: readonly StockLine[]): Promise<{ reserved: boolean }> {
  return Promise.reject(notImplemented('reserve', 'commerio-backend#206', 'Khang'));
}

/** Trả phần đang giữ của kiện. */
export function release(_packageId: string, _lines: readonly StockLine[]): Promise<void> {
  return Promise.reject(notImplemented('release', 'commerio-backend#206', 'Khang'));
}

/** Bàn giao kiện: trừ tồn thực và đang giữ, lập phiếu xuất theo kiện. */
export function ship(_packageId: string, _lines: readonly StockLine[], _opts: { actorId: string }): Promise<{ documentId: string; number: string }> {
  return Promise.reject(notImplemented('ship', 'commerio-backend#206', 'Khang'));
}

/** Đảo bàn giao: cộng lại tồn thực, lập phiếu đảo. */
export function reverseShipment(
  _packageId: string,
  _lines: readonly StockLine[],
  _opts: { actorId: string; reason: string },
): Promise<{ documentId: string; number: string }> {
  return Promise.reject(notImplemented('reverseShipment', 'commerio-backend#206', 'Khang'));
}
