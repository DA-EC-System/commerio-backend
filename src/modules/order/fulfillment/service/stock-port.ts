// Cổng tồn theo kiện (Documents/21 §11.1): mặc định trỏ sang cổng của inventory (`product/index.ts`). Mọi hàm chạy trong
// giao dịch của bên gọi; bên gọi khoá kiện trước. Cổng nào ném 501 `not_implemented` thì bên gọi bắt và ghi `notices`
// lên kiện (#198, Documents/21 §18.7.9).
import {
  type DocumentRef,
  receiveBack,
  release,
  reserve,
  reverseShipment,
  type ShipLine,
  type ShipOptions,
  ship,
  type StockLine,
  type StockSnapshot,
  stockOf,
} from '../../../product/index.ts';

export type { DocumentRef, ShipLine, StockLine, StockSnapshot };

export interface StockPort {
  /** Giữ hàng cho kiện; `reserved: false` khi không đủ khả dụng. */
  reserve(packageId: string, lines: readonly StockLine[]): Promise<{ reserved: boolean }>;
  /** Trả phần đang giữ của kiện. */
  release(packageId: string, lines: readonly StockLine[]): Promise<void>;
  /** Phiếu `XK`, trừ tồn thực (và đang giữ khi không `forced`); lưới gọi lặp theo `packageLineId`. */
  ship(packageId: string, lines: readonly ShipLine[], opts: ShipOptions): Promise<DocumentRef>;
  /** Phiếu `DX`, đảo đủ cả lượt bàn giao đang xuất. */
  reverseShipment(packageId: string, lines: readonly StockLine[], opts: { actorId: string; reason: string }): Promise<DocumentRef>;
  /** Các con số và giá vốn bình quân. */
  stockOf(variantIds: readonly string[]): Promise<Map<string, StockSnapshot>>;
  /** Phiếu `KT` nháp cho hàng hoàn về (số dự kiến theo SKU, tồn chưa đổi tới khi phiếu ghi sổ); gọi lại cùng nguồn trả phiếu cũ. */
  receiveBack(source: { type: 'package'; id: string }, lines: readonly StockLine[]): Promise<DocumentRef>;
}

const real: StockPort = { reserve, release, ship, reverseShipment, stockOf, receiveBack };

let port: StockPort = real;

export const stockPort = (): StockPort => port;

/** Test thay một phần cổng (phần còn lại là bản thật); gọi không tham số để trả lại bản thật. */
export function setStockPort(next: Partial<StockPort> = {}): void {
  port = { ...real, ...next };
}
