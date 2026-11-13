import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { registerConfigOpenApi } from './config-openapi.ts';
import { registerLedgerOpenApi } from './ledger-openapi.ts';
import { registerPaymentOpenApi } from './payment-openapi.ts';
import { registerSettlementOpenApi } from './settlement-openapi.ts';

/**
 * Đường dẫn Swagger của module `finance`, viết tương đối với /api/v1/finance (Documents/21 mục 21). Hoá đơn, phiếu
 * thu, phiếu chi, COD, khoản thu chưa khớp, hoàn tiền kiểu cũ (mục 12 cũ) đã gỡ ở #235.
 */
export function registerFinanceOpenApi(registry: OpenAPIRegistry): void {
  registerSettlementOpenApi(registry);
  registerConfigOpenApi(registry);
  registerLedgerOpenApi(registry);
  registerPaymentOpenApi(registry);
}
