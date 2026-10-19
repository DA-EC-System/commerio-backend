// API công khai của module `report`: bảng số liệu dựng sẵn, tính lại từ module nguồn (Documents/21 D7, D18).
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../shared/module.ts';
import { registerReportOpenApi } from './api/openapi.ts';
import { reportRouter } from './api/routes.ts';
import { startReportBackground } from './service/background.ts';

export const reportModule: ModuleDefinition = {
  name: 'report',
  router: reportRouter,
  openapi: registerReportOpenApi,
  startBackground: startReportBackground,
};
