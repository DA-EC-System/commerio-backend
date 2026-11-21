// Biểu phí mẫu của nền tảng (Documents/21 §21.6; Thành chốt 22/11/2026 câu 3): một bộ dùng chung mọi công ty, chỉ là gợi
// ý để soạn cấu hình phí; công ty đọc, quản trị nền tảng sửa. Không tự áp, không tự đổi cấu hình đã duyệt.
import { inTransaction, withCompany } from '../../../../shared/db/client.ts';
import { pgError } from '../../../../shared/db/pg-error.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import { recordAudit } from '../../../core/index.ts';
import type { ConfigPayload } from '../domain/config-version.ts';
import { FeeTemplateCreate, FeeTemplateUpdate, issuesToErrors } from '../domain/fee-template.ts';
import { type FeeTemplateRow, findFeeTemplate, findFeeTemplates, insertFeeTemplate, updateFeeTemplateIfVersion } from '../repository/fee-templates.ts';

const ENTITY = 'finance.fee_templates';
const invalid = (errors: Record<string, string>) => new AppError(422, 'validation_failed', 'Dữ liệu gửi lên không hợp lệ', { errors });
const notFound = () => new AppError(404, 'not_found', 'Không tìm thấy biểu phí mẫu');

export interface FeeTemplateDeps {
  /** Sàn có trong `channel.marketplaces` (cổng channel, `src/wiring.ts`). */
  marketplaceExists: (platform: string) => Promise<boolean>;
}

/** `FeeTemplate` của Documents/21 §21.6. */
export function feeTemplateView(r: FeeTemplateRow) {
  return {
    id: r.id,
    platform: r.platform,
    shopType: r.shopType,
    shopTypeLabel: r.shopTypeLabel,
    payload: r.payload as ConfigPayload<'fee'>,
    sources: r.sources as { title: string; url: string; updatedAt: string }[],
    effectiveFrom: r.effectiveFrom,
    note: r.note,
    version: r.version,
    updatedAt: r.updatedAt.toISOString(),
  };
}
export type FeeTemplateView = ReturnType<typeof feeTemplateView>;

const label = (r: Pick<FeeTemplateRow, 'platform' | 'shopTypeLabel'>) => `Biểu phí mẫu ${r.platform} · ${r.shopTypeLabel}`;

/** Công ty đọc (người soạn, người duyệt cấu hình phí): chạy trong `withCompany`, `commerio_app` chỉ có quyền đọc bảng. */
export async function listFeeTemplates(companyId: string, platform?: string): Promise<{ items: FeeTemplateView[] }> {
  return withCompany(companyId, async () => ({ items: (await findFeeTemplates(platform)).map(feeTemplateView) }));
}

/** Quản trị nền tảng: role chủ bảng, ngoài `withCompany`. */
export async function listPlatformFeeTemplates(): Promise<{ items: FeeTemplateView[] }> {
  return inTransaction(async () => ({ items: (await findFeeTemplates()).map(feeTemplateView) }));
}

export async function createFeeTemplate(actorId: string, body: unknown, deps: FeeTemplateDeps): Promise<FeeTemplateView> {
  const parsed = FeeTemplateCreate.safeParse(body);
  if (!parsed.success) throw invalid(issuesToErrors(parsed.error.issues));
  const input = parsed.data;
  if (!(await deps.marketplaceExists(input.platform))) throw invalid({ platform: 'Không có sàn này' });
  return inTransaction(async () => {
    const row = await insertFeeTemplate({ ...input, updatedBy: actorId }).catch((err: unknown) => {
      if (pgError(err).code === '23505') {
        throw new AppError(409, 'template_exists', 'Đã có biểu phí mẫu cho sàn và loại shop này', { errors: { shopType: 'Đã có mẫu cùng loại shop' } });
      }
      throw err;
    });
    await recordAudit({ companyId: null, actorId, action: 'create', entityType: ENTITY, entityId: row.id, label: label(row), before: null, after: feeTemplateView(row) });
    return feeTemplateView(row);
  });
}

export async function updateFeeTemplate(actorId: string, id: string, body: unknown): Promise<FeeTemplateView> {
  if (!isUuid(id)) throw notFound();
  const parsed = FeeTemplateUpdate.safeParse(body);
  if (!parsed.success) throw invalid(issuesToErrors(parsed.error.issues));
  const { version, ...set } = parsed.data;
  return inTransaction(async () => {
    const before = await findFeeTemplate(id);
    if (!before) throw notFound();
    const row = await updateFeeTemplateIfVersion(id, version, { ...set, updatedBy: actorId });
    if (!row) throw new AppError(409, 'version_conflict', 'Biểu phí mẫu vừa được người khác sửa', { current: feeTemplateView(before) });
    await recordAudit({
      companyId: null,
      actorId,
      action: 'update',
      entityType: ENTITY,
      entityId: id,
      label: label(row),
      before: feeTemplateView(before),
      after: feeTemplateView(row),
    });
    return feeTemplateView(row);
  });
}
