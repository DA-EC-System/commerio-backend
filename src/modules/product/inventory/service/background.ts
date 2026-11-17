// Việc nền của inventory (#204): nghe đổi trạng thái kinh doanh SKU để xét lại cảnh báo dưới ngưỡng (Documents/21 V31,
// 25 §7.5). Catalog ở dưới inventory nên không gọi thẳng `recheckThresholds` được.
import { type EventEnvelope, type EventPayload, registerConsumer } from '../../../core/index.ts';
import { recheckThresholds } from './thresholds.ts';

type StatusChanged = Pick<EventEnvelope<'catalog.variant_status_changed', EventPayload<'catalog.variant_status_changed'>>, 'payload'>;

/**
 * SKU sang Ngừng nhập, Lưu trữ thì tắt cảnh báo; quay lại Kinh doanh, Tạm ngừng mà đang dưới ngưỡng thì báo lại. Bên
 * consumer bọc `withCompany` của công ty mang sự kiện và chống xử lý trùng; gọi lại cũng không báo trùng.
 */
export async function onVariantStatusChanged(event: StatusChanged): Promise<void> {
  await recheckThresholds([event.payload.variantId]);
}

export function startInventoryConsumers(): void {
  registerConsumer('catalog.variant_status_changed', onVariantStatusChanged, { consumer: 'inventory-variant-status' });
}
