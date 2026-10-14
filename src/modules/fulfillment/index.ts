// API công khai của module `fulfillment`: State Machine duyệt đơn, lịch sử chuyển trạng thái, lô nhặt/đóng gói.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../shared/module.ts';

export const fulfillmentModule: ModuleDefinition = { name: 'fulfillment' };
