// API công khai của module `onboarding`: checklist thiết lập ban đầu (#461, Documents/21 mục 23).
// Không có bảng: đọc chéo core, product, channel qua cổng công khai. Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../../shared/module.ts';
import { registerOnboardingOpenApi } from './api/openapi.ts';
import { onboardingRouter } from './api/routes.ts';

export const onboardingModule: ModuleDefinition = {
  name: 'onboarding',
  router: onboardingRouter,
  openapi: registerOnboardingOpenApi,
};
