// Bật, tắt phân hệ tuỳ chọn của công ty (UC-PI-02, Documents/21 M1–M4, #152).
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { recordAudit } from '../../audit/index.ts';
import { OPTIONAL_MODULES, type OptionalModule } from '../domain/modules.ts';
import { enabledModuleCodes } from '../repository/companies.ts';
import { findModuleRows, lockModuleRow, type ModuleRow, saveModule } from '../repository/modules.ts';
import { type AccountRef, accountRefs, type PlatformContext } from './context.ts';

export interface CompanyModuleView {
  code: OptionalModule;
  enabled: boolean;
  enabledAt: string | null;
  enabledBy: AccountRef | null;
  aiConsentAt: string | null;
  aiConsentBy: AccountRef | null;
  hasData: boolean;
}

const isOptional = (code: string): code is OptionalModule => (OPTIONAL_MODULES as readonly string[]).includes(code);

const hasData = async (ctx: PlatformContext, code: OptionalModule) => (await ctx.moduleData?.[code]?.()) ?? false;

/** Phân hệ đang tắt không mang người bật, lúc bật (như mock FE). */
async function toViews(ctx: PlatformContext, codes: readonly OptionalModule[], rows: readonly ModuleRow[]) {
  const ref = await accountRefs(ctx, rows.flatMap((r) => [r.enabledBy, r.aiConsentBy]));
  return Promise.all(
    codes.map(async (code): Promise<CompanyModuleView> => {
      const row = rows.find((r) => r.moduleCode === code && r.enabled);
      return {
        code,
        enabled: !!row,
        enabledAt: row?.updatedAt.toISOString() ?? null,
        enabledBy: ref(row?.enabledBy ?? null),
        aiConsentAt: row?.aiConsentAt?.toISOString() ?? null,
        aiConsentBy: ref(row?.aiConsentBy ?? null),
        hasData: await hasData(ctx, code),
      };
    }),
  );
}

export function listCompanyModules(ctx: PlatformContext, companyId: string): Promise<CompanyModuleView[]> {
  return withCompany(companyId, async () => toViews(ctx, OPTIONAL_MODULES, await findModuleRows(OPTIONAL_MODULES)));
}

/**
 * Khoá dòng phân hệ rồi kiểm theo thứ tự của mock FE: trạng thái đích trùng → 409 `module_state_changed`; bật
 * assistant thiếu đồng ý → 422; tắt khi đã có dữ liệu → 409 `module_has_data`. Ghi nhật ký cùng giao dịch.
 */
export function setCompanyModule(
  ctx: PlatformContext,
  caller: { accountId: string; companyId: string },
  code: string,
  input: { enabled: boolean; aiConsent?: boolean | undefined },
) {
  if (!isOptional(code)) throw new AppError(404, 'module_not_found', 'Không có phân hệ tuỳ chọn này');
  return withCompany(caller.companyId, async () => {
    const before = await lockModuleRow(caller.companyId, code);
    const current = async () => (await toViews(ctx, [code], [before]))[0]!;
    if (before.enabled === input.enabled) {
      throw new AppError(409, 'module_state_changed', 'Phân hệ vừa được đổi ở phiên khác', { current: await current() });
    }
    const aiConsent = input.enabled && code === 'assistant';
    if (aiConsent && input.aiConsent !== true) {
      throw new AppError(422, 'ai_consent_required', 'Bật Trợ lý AI cần đồng ý gửi dữ liệu tới OpenAI');
    }
    if (!input.enabled && (await hasData(ctx, code))) {
      throw new AppError(409, 'module_has_data', 'Phân hệ đã có dữ liệu nên không tắt được', { current: await current() });
    }
    const saved = await saveModule(caller.companyId, code, { enabled: input.enabled, actorId: caller.accountId, aiConsent });
    await recordAudit({
      companyId: caller.companyId,
      actorId: caller.accountId,
      action: 'update',
      entityType: 'core.company_modules',
      entityId: null,
      before: { module: code, enabled: before.enabled },
      after: aiConsent
        ? { module: code, enabled: true, aiConsentAt: saved.aiConsentAt?.toISOString() }
        : { module: code, enabled: input.enabled },
    });
    return {
      module: (await toViews(ctx, [code], [saved]))[0]!,
      enabledModules: await enabledModuleCodes(caller.companyId),
    };
  });
}
