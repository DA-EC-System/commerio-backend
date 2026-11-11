// BẢN TẠM cho channel (#198 phần 2, commerio-backend#289): bản thật là `settleOpeningStocktake` ở `service/allocation.ts`
// của #199 phần b (commerio-backend#298, Khang), cùng chữ ký (Documents/21 §11.3). #298 merge trước thì xoá file này và
// dòng export của nó ở `index.ts`, giữ export của #298.
import { publishEvent } from '../../../core/index.ts';
import { settleDeferredHandovers } from './handover-stock.ts';

/**
 * Gọi trong giao dịch thoát chờ kiểm kê của channel, sau khi đặt `openingStocktake = null`. Bản tạm chỉ bù kiện hoãn trừ
 * (`settleDeferredHandovers` đã có trên `main`) và luôn phát `fulfillment.allocation_done` có `cause` của phiếu với
 * `variantIds` rỗng, để gian hàng không kẹt ở chờ phân hàng; chưa phân hàng cho kiện chưa bàn giao (`held` luôn 0). Lỗi
 * thì ném, giao dịch của bên gọi rollback.
 */
export async function settleOpeningStocktake(p: {
  shopId: string;
  documentId: string;
  countedAt: Date;
}): Promise<{ deducted: number; storedOnly: number; held: number }> {
  const settled = await settleDeferredHandovers(p.shopId, p.countedAt);
  await publishEvent({
    type: 'fulfillment.allocation_done',
    aggregateId: p.documentId,
    payload: { variantIds: [], cause: { type: 'stocktake', documentId: p.documentId } },
  });
  return { ...settled, held: 0 };
}
