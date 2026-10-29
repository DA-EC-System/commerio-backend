// API công khai của module `files`: thông tin tệp; nội dung nằm ở SeaweedFS/S3.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../../shared/module.ts';
import { registerFilesOpenApi } from './api/openapi.ts';
import { filesRouter } from './api/routes.ts';

export const filesModule: ModuleDefinition = {
  name: 'files',
  router: filesRouter,
  openapi: registerFilesOpenApi,
};
