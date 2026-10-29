// API công khai của module `purchasing`: nhà cung cấp, đề nghị nhập, phiếu nhận, phiếu trả NCC.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../../shared/module.ts';
import { registerPurchasingOpenApi } from './api/openapi.ts';
import { purchasingRouter } from './api/routes.ts';

export const purchasingModule: ModuleDefinition = {
  name: 'purchasing',
  router: purchasingRouter,
  openapi: registerPurchasingOpenApi,
};

/** Đang về theo biến thể (Documents/25 §3.1); inventory nhận qua `ctx` (`product/index.ts`). */
export { incomingByVariant as incomingOf } from './repository/requests.ts';

/** Chặn tắt phân hệ Mua hàng khi đã có dữ liệu (#152); `src/wiring.ts` đưa cho `platform`. */
export { hasPurchasingData } from './repository/suppliers.ts';
