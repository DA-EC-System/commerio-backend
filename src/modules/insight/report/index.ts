// API công khai của module `report`: số liệu trang Tổng quan gom thẳng từ sổ tiền (Documents/21 D18, §21.5; #333).
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../../shared/module.ts';
import { registerReportOpenApi } from './api/openapi.ts';
import { reportRouter } from './api/routes.ts';

export const reportModule: ModuleDefinition = {
  name: 'report',
  router: reportRouter,
  openapi: registerReportOpenApi,
};
