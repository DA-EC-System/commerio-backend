import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { registerWebhookOpenApi } from './openapi-webhooks.ts';

/**
 * Đường dẫn Swagger của module `payment`, viết tương đối với /api/v1/payment. Chỉ còn webhook của cổng; route cổng,
 * mã thanh toán, trạng thái tiền của đơn kiểu cũ, giao dịch cổng, mô phỏng trả tiền đã gỡ ở #235.
 */
export function registerPaymentOpenApi(registry: OpenAPIRegistry): void {
  registerWebhookOpenApi(registry);
}
