// API công khai của module `files`: thông tin tệp, tệp đính kèm chứng từ; nội dung nằm ở Cloudflare R2 (API S3).
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../../shared/module.ts';
import { registerFilesOpenApi } from './api/openapi.ts';
import { filesRouter } from './api/routes.ts';

export const filesModule: ModuleDefinition = {
  name: 'files',
  router: filesRouter,
  openapi: registerFilesOpenApi,
};

export {
  type Attachment,
  attachmentIdsOf,
  attachmentProblem,
  attachmentsOf,
  confirmUploads,
  type EntityRef,
  hasAttachments,
  MAX_ATTACHMENTS,
  replaceAttachments,
} from './service/attachments.ts';
