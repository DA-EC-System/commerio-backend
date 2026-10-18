// API công khai của module `platform`: công ty, phân hệ đang bật, trạng thái khoá công ty.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../shared/module.ts';
import { CORE_MODULES, type ModuleCode, OPTIONAL_MODULES, type OptionalModule } from './domain/modules.ts';
import { type CompanyRow, enabledModuleCodes, findCompanies, insertCompany, insertModules } from './repository/companies.ts';

export const platformModule: ModuleDefinition = { name: 'platform' };

export { CORE_MODULES, OPTIONAL_MODULES };
export type { CompanyRow, ModuleCode, OptionalModule };

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
