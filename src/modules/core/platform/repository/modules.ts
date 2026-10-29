import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import type { OptionalModule } from '../domain/modules.ts';
import { companyModules } from './schema.ts';

export type ModuleRow = typeof companyModules.$inferSelect;

const rowOf = (companyId: string, code: OptionalModule) =>
  and(eq(companyModules.companyId, companyId), eq(companyModules.moduleCode, code));

/** Dòng phân hệ tuỳ chọn của công ty đang chọn (RLS lọc); phân hệ chưa từng bật thì không có dòng. */
export function findModuleRows(codes: readonly OptionalModule[]): Promise<ModuleRow[]> {
  return getDb()
    .select()
    .from(companyModules)
    .where(inArray(companyModules.moduleCode, [...codes]));
}

/**
 * Khoá dòng phân hệ tới hết giao dịch. Chưa từng bật thì chèn dòng đang tắt trước: hai phiên cùng chèn thì phiên sau
 * chờ phiên trước commit rồi khoá dòng đã có, nên luôn thấy trạng thái mới nhất.
 */
export async function lockModuleRow(companyId: string, code: OptionalModule): Promise<ModuleRow> {
  await getDb().insert(companyModules).values({ companyId, moduleCode: code, enabled: false }).onConflictDoNothing();
  const [row] = await getDb().select().from(companyModules).where(rowOf(companyId, code)).for('update');
  return row!;
}

/** Bật hoặc tắt dòng đã khoá; bật thì ghi người bật, lúc bật (`updated_at`) và đồng ý gửi dữ liệu. */
export async function saveModule(
  companyId: string,
  code: OptionalModule,
  input: { enabled: boolean; actorId: string; aiConsent: boolean },
): Promise<ModuleRow> {
  const now = new Date();
  const enableFields = input.enabled
    ? {
        enabledBy: input.actorId,
        aiConsentAt: input.aiConsent ? now : null,
        aiConsentBy: input.aiConsent ? input.actorId : null,
      }
    : {};
  const [row] = await getDb()
    .update(companyModules)
    .set({ enabled: input.enabled, ...enableFields, updatedAt: now, version: sql`${companyModules.version} + 1` })
    .where(rowOf(companyId, code))
    .returning();
  return row!;
}
