// Người thao tác trên kiện (kho quét bàn giao, quét nhận hoàn; CEO huỷ bàn giao). File chỉ có kiểu, để `handover.ts`,
// `delivery.ts`, `api/routes.ts` cùng import mà không thành vòng qua `handover-stock.ts`.
export interface Actor {
  companyId: string;
  accountId: string;
  permissions: readonly string[];
  enabledModules: readonly string[];
}
