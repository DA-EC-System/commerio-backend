// Cổng tồn theo kiện (Documents/21 §11.1): mặc định trỏ sang `reserve`, `release` của inventory (`product/index.ts`).
// Thân hai hàm có từ commerio-backend#206. Cổng nào ném 501 `not_implemented` thì bên gọi bắt và ghi `notices` lên kiện
// (#198, Documents/21 §18.7.9).
import { release, reserve } from '../../../product/index.ts';

export interface StockLine {
  variantId: string;
  quantity: number;
}

export interface StockPort {
  /** Giữ hàng cho kiện; `reserved: false` khi không đủ khả dụng. */
  reserve(packageId: string, lines: readonly StockLine[]): Promise<{ reserved: boolean }>;
  /** Trả phần đang giữ của kiện. */
  release(packageId: string, lines: readonly StockLine[]): Promise<void>;
}

const pending: StockPort = { reserve, release };

let port: StockPort = pending;

export const stockPort = (): StockPort => port;

/** Test thay cổng; gọi không tham số để trả lại bản mặc định. */
export function setStockPort(next: StockPort = pending): void {
  port = next;
}
