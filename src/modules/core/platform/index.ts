// API công khai của module `platform`: công ty, phân hệ đang bật, trạng thái khoá công ty.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../../shared/module.ts';
import { registerPlatformOpenApi } from './api/openapi.ts';
import { platformRouter } from './api/routes.ts';
import { CORE_MODULES, type ModuleCode, OPTIONAL_MODULES, type OptionalModule } from './domain/modules.ts';
import { type CompanyRow, enabledModuleCodes, findCompanies, insertCompany, insertModules } from './repository/companies.ts';
import { startOutboxBackground } from './service/outbox/public.ts';

export const platformModule: ModuleDefinition = {
  name: 'platform',
  router: platformRouter,
  openapi: registerPlatformOpenApi,
  startBackground: startOutboxBackground,
};

export { CORE_MODULES, OPTIONAL_MODULES };
export type { CompanyRow, ModuleCode, OptionalModule };
export type { PlatformContext } from './service/context.ts';

// Sự kiện giữa module (Documents/21 D4–D7), cách dùng ở service/outbox/README.md.
export type { EventEnvelope } from '../../../shared/events/envelope.ts';
export { EVENT_SCHEMAS, EVENT_TYPES, type EventPayload, type EventType } from './domain/events.ts';
export { publishEvent, registerConsumer, stopInstanceConsumers } from './service/outbox/public.ts';

// Máy trạng thái và lịch sử chuyển (Documents/21 mục 14.1). Lịch sử kèm tên người: `getStatusHistory` của `staff`.
export {
  assertTransition,
  availableActions,
  defineMachine,
  type StateMachine,
  type Transition,
  type TransitionContext,
} from './domain/state-machine.ts';
export {
  listTransitions,
  recordTransition,
  type TransitionRecord,
  type TransitionRow,
  type TransitionSource,
} from './repository/transitions.ts';

/**
 * Tạo công ty mới và bật mười phân hệ lõi cùng các phân hệ tuỳ chọn đã chọn (UC-PI-01 bước 6, 7).
 * Gọi trong transaction của bên gọi.
 */
export async function createCompany(input: {
  name: string;
  taxCode: string;
  optionalModules: readonly OptionalModule[];
  aiConsent: boolean;
  createdBy: string;
}): Promise<string> {
  const id = await insertCompany({ name: input.name, taxCode: input.taxCode });
  await insertModules(id, [...CORE_MODULES, ...input.optionalModules], {
    enabledBy: input.createdBy,
    aiConsent: input.aiConsent,
  });
  return id;
}

export async function getCompanies(ids: readonly string[]): Promise<Map<string, CompanyRow>> {
  return new Map((await findCompanies(ids)).map((c) => [c.id, c]));
}

export const getEnabledModules = enabledModuleCodes;
