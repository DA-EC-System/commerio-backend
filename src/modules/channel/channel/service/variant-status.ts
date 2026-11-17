// `catalog.variant_status_changed` (#224, Documents/21 §11.2): SKU vào hoặc rời tạm ngừng thì xếp `channel.stock_push`
// cho các gian hàng có listing của SKU, cùng giao dịch của consumer; việc chạy bước ẩn, hiện (`listing-sync.ts`
// `applyVisibility`). Không gọi sàn trong consumer.
import { requireCompanyId } from '../../../../shared/db/client.ts';
import type { EventPayload } from '../../../core/index.ts';
import { shopsShowingVariant } from '../repository/listings.ts';
import { sendStockPush } from './shop-jobs.ts';

export async function onVariantStatusChanged(event: EventPayload<'catalog.variant_status_changed'>): Promise<void> {
  if (event.from !== 'paused' && event.to !== 'paused') return;
  const companyId = requireCompanyId('onVariantStatusChanged');
  for (const shopId of await shopsShowingVariant(event.variantId)) await sendStockPush(companyId, shopId);
}
