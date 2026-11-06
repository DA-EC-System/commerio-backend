// Cổng kiểm kê đầu kỳ của inventory (Documents/21 §11.3), thân ở commerio-backend#245. Tách khỏi `ProductPort` để các bản
// giả `ProductPort` trong test không phải thêm hàm. Gọi trong `withCompany` của bên gọi.
import { createOpeningStocktake, stockDocumentStatusOf } from '../../../product/index.ts';

export type OpeningStocktakeStatus = 'draft' | 'pending' | 'rejected' | 'posted' | 'cancelled';

export interface StocktakePort {
  /** Lập phiếu kiểm kê nháp nguồn `shop_setup`; gọi lại khi đã có phiếu nháp thì trả phiếu cũ, `created: false`. */
  createOpeningStocktake(shopId: string, opts: { actorId: string }): Promise<{ documentId: string; number: string; created: boolean }>;
  /** Trạng thái phiếu theo id (đề xuất thêm vào §11.3 cùng #198). */
  openingStocktakeStatusOf(documentIds: readonly string[]): Promise<Map<string, OpeningStocktakeStatus>>;
}

const real: StocktakePort = {
  createOpeningStocktake,
  openingStocktakeStatusOf: stockDocumentStatusOf,
};

let port: StocktakePort = real;

export const stocktakePort = (): StocktakePort => port;

/** Test thay cổng; gọi không tham số để trả lại bản mặc định. */
export function setStocktakePort(next: StocktakePort = real): void {
  port = next;
}
