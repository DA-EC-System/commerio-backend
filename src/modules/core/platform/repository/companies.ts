import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import type { ModuleCode } from '../domain/modules.ts';
import { companies, companyModules } from './schema.ts';

export interface CompanyRow {
  id: string;
  name: string;
  status: 'active' | 'locked';
}

export async function insertCompany(input: { name: string; taxCode: string }): Promise<string> {
  const [row] = await getDb().insert(companies).values(input).returning({ id: companies.id });
  return row!.id;
}

export async function insertModules(
  companyId: string,
  codes: readonly ModuleCode[],
  opts: { enabledBy: string; aiConsent: boolean },
): Promise<void> {
  const now = new Date();
  await getDb()
    .insert(companyModules)
    .values(
      codes.map((moduleCode) => ({
        companyId,
        moduleCode,
        enabledBy: opts.enabledBy,
        aiConsentAt: moduleCode === 'assistant' && opts.aiConsent ? now : null,
        aiConsentBy: moduleCode === 'assistant' && opts.aiConsent ? opts.enabledBy : null,
      })),
    );
}

export async function findCompanies(ids: readonly string[]): Promise<CompanyRow[]> {
  if (ids.length === 0) return [];
  return getDb()
    .select({ id: companies.id, name: companies.name, status: companies.status })
    .from(companies)
    .where(inArray(companies.id, [...ids]));
}

export async function enabledModuleCodes(companyId: string): Promise<ModuleCode[]> {
  const rows = await getDb()
    .select({ code: companyModules.moduleCode })
    .from(companyModules)
    .where(and(eq(companyModules.companyId, companyId), eq(companyModules.enabled, true)));
  return rows.map((r) => r.code);
}

export interface CompanyProfileRow {
  id: string;
  name: string;
  taxCode: string | null;
  address: string | null;
  responsibleName: string | null;
  responsibleAddress: string | null;
  version: number;
}

export type CompanyProfilePatch = Partial<Pick<CompanyProfileRow, 'address' | 'responsibleName' | 'responsibleAddress'>>;

const profileColumns = {
  id: companies.id,
  name: companies.name,
  taxCode: companies.taxCode,
  address: companies.address,
  responsibleName: companies.responsibleName,
  responsibleAddress: companies.responsibleAddress,
  version: companies.version,
};

export async function findCompanyProfile(id: string): Promise<CompanyProfileRow | undefined> {
  const [row] = await getDb().select(profileColumns).from(companies).where(eq(companies.id, id));
  return row;
}

/** Sửa theo `version`; `undefined` khi lệch version. Chạy bằng role chủ bảng (`commerio_app` không có UPDATE). */
export async function updateCompanyProfile(
  id: string,
  version: number,
  patch: CompanyProfilePatch,
): Promise<CompanyProfileRow | undefined> {
  const [row] = await getDb()
    .update(companies)
    .set({ ...patch, updatedAt: new Date(), version: sql`${companies.version} + 1` })
    .where(and(eq(companies.id, id), eq(companies.version, version)))
    .returning(profileColumns);
  return row;
}
