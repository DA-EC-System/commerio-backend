// Cổng kiểm kê đầu kỳ của inventory (Documents/21 §11.3), thân làm ở commerio-backend#245 (Bình). Tách khỏi `ProductPort`
// để các bản giả `ProductPort` trong test không phải thêm hàm. Gọi trong `withCompany` của bên gọi.
import { notImplemented } from '../../../../shared/errors/app-error.ts';

export type OpeningStocktakeStatus = 'draft' | 'pending' | 'rejected' | 'posted' | 'cancelled';

export interface StocktakePort {
  /** Lập phiếu kiểm kê nháp nguồn `shop_setup`; gọi lại khi đã có phiếu nháp thì trả phiếu cũ, `created: false`. */
  createOpeningStocktake(shopId: string, opts: { actorId: string }): Promise<{ documentId: string; number: string; created: boolean }>;
  /** Trạng thái phiếu theo id (đề xuất thêm vào §11.3 cùng #198). */
  openingStocktakeStatusOf(documentIds: readonly string[]): Promise<Map<string, OpeningStocktakeStatus>>;
}

const pending: StocktakePort = {
  createOpeningStocktake: () => Promise.reject(notImplemented('createOpeningStocktake', 'commerio-backend#245', 'Bình')),
  // Chưa có #245 thì không gian hàng nào có phiếu (lập phiếu ném 501), nên hàm này chỉ chạy với phiếu do bản giả tạo.
  openingStocktakeStatusOf: async (ids) => new Map(ids.map((id) => [id, 'draft'])),
};

let port: StocktakePort = pending;

export const stocktakePort = (): StocktakePort => port;

/** Test thay cổng; gọi không tham số để trả lại bản mặc định. */
export function setStocktakePort(next: StocktakePort = pending): void {
  port = next;
}
