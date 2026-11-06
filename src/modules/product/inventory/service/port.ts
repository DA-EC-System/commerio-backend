// Hàm inventory cho module con khác cùng module lớn `product` (spec #111 mục 5.5). Chạy trong `withCompany` của bên gọi.
import { randomUUID } from 'node:crypto';
import { getVariants } from '../../catalog/index.ts';
import type { StockLine } from '../domain/documents.ts';
import { availableQty } from '../domain/stock.ts';
import { takeNextNumber } from '../repository/counters.ts';
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

// shortcut: tạm khoá luôn 0 vì chưa có phiếu kho chờ duyệt; tính từ phiếu giảm `pending` khi làm B3 (spec #111 Q4).
export const lockedOf = (_variantId: string) => 0;

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

// Chữ ký cổng theo kiện (Documents/21 mục 11.1, bản 29/10/2026). Hiện là bản giả trả thành công để fulfillment và yêu
// cầu trả code theo (spec 2026-11-06-206 Q23); thân thật làm ở PR sau của #206.

export type { StockLine } from '../domain/documents.ts';

const fakeDocument = (number: string) => Promise.resolve({ documentId: randomUUID(), number });

/** Giữ hàng cho kiện; `reserved: false` khi không đủ khả dụng. */
export function reserve(_packageId: string, _lines: readonly StockLine[]): Promise<{ reserved: boolean }> {
  // shortcut: bản giả, không cộng đang giữ; thân thật theo spec 2026-11-06-206 mục 5.5.
  return Promise.resolve({ reserved: true });
}

/** Trả phần đang giữ của kiện. */
export function release(_packageId: string, _lines: readonly StockLine[]): Promise<void> {
  // shortcut: bản giả, không trừ đang giữ; thân thật theo spec 2026-11-06-206 mục 5.5.
  return Promise.resolve();
}

/** Bàn giao kiện: trừ tồn thực và đang giữ, lập phiếu xuất theo kiện. */
export function ship(_packageId: string, _lines: readonly StockLine[], _opts: { actorId: string }): Promise<{ documentId: string; number: string }> {
  // shortcut: bản giả, không trừ tồn, không lập phiếu; thân thật theo spec 2026-11-06-206 mục 5.5.
  return fakeDocument('XK-000000');
}

/** Đảo bàn giao: cộng lại tồn thực, lập phiếu đảo. */
export function reverseShipment(
  _packageId: string,
  _lines: readonly StockLine[],
  _opts: { actorId: string; reason: string },
): Promise<{ documentId: string; number: string }> {
  // shortcut: bản giả, không cộng tồn, không lập phiếu; thân thật theo spec 2026-11-06-206 mục 5.5.
  return fakeDocument('DX-000000');
}

/** Hàng hoàn hoặc khách trả về kho: lập phiếu kiểm hàng hoàn; tồn chưa đổi tới khi phiếu đó ghi sổ (Documents/21 mục 11.1, 15.3). */
export function receiveBack(
  _source: { type: 'package' | 'return_request'; id: string },
  _lines: readonly StockLine[],
): Promise<{ documentId: string; number: string }> {
  // shortcut: bản giả, không lập phiếu; thân thật theo spec 2026-11-06-206 mục 5.5.
  return fakeDocument('KT-000000');
}
