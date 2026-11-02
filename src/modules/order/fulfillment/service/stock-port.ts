// Cổng tồn theo kiện (Documents/21 §11.1). `reserve`, `release` của inventory chưa có thân (#111), nên mặc định là bản
// "chưa giữ được": kiện ở `backordered`, nhả hàng không làm gì (#105 A2). #111 xong thì trỏ sang `product/index.ts`.

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

const pending: StockPort = {
  reserve: async () => ({ reserved: false }),
  release: async () => {},
};

let port: StockPort = pending;

export const stockPort = (): StockPort => port;

/** Test thay cổng; gọi không tham số để trả lại bản mặc định. */
export function setStockPort(next: StockPort = pending): void {
  port = next;
}
