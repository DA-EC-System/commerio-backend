// Mốc hoàn tất onboarding của công ty (#569, Documents/21 mục 11.3, 23): cổng cho insight onboarding.
// Ngoại lệ có chủ đích của "không lưu cờ": chỉ quyết định có ép vào wizard hay không, đặt một lần, không xoá.
import { requireCompanyId } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { recordAudit } from '../../audit/index.ts';
import { findOnboardingCompletedAt, setOnboardingCompletedAt } from '../repository/companies.ts';

/** ISO của công ty đang chọn; gọi trong `withCompany` của bên gọi. */
export async function onboardingCompletedAt(): Promise<string | null> {
  const at = await findOnboardingCompletedAt(requireCompanyId('onboardingCompletedAt'));
  return at ? at.toISOString() : null;
}

/**
 * `UPDATE … WHERE onboarding_completed_at IS NULL`. Đổi được đúng một dòng thì ghi nhật ký (người làm là `actorId`) trong
 * cùng giao dịch và trả `changed: true`; đã có mốc (gọi lại, hai lời gọi đua) thì đọc lại mốc cũ, `changed: false`.
 * Bên gọi bọc `inTransaction` ngoài `withCompany`: `commerio_app` không có UPDATE trên `core.companies`.
 */
export async function markOnboardingCompleted(input: {
  companyId: string;
  actorId: string;
}): Promise<{ completedAt: string; changed: boolean }> {
  const { companyId, actorId } = input;
  const set = await setOnboardingCompletedAt(companyId, new Date());
  if (set) {
    const completedAt = set.at.toISOString();
    await recordAudit({
      companyId,
      actorId,
      action: 'update',
      operation: 'onboarding.completed',
      entityType: 'core.companies',
      entityId: companyId,
      label: set.name,
      after: { onboardingCompletedAt: completedAt },
    });
    return { completedAt, changed: true };
  }
  const at = await findOnboardingCompletedAt(companyId);
  if (!at) throw new AppError(404, 'not_found', 'Không tìm thấy công ty');
  return { completedAt: at.toISOString(), changed: false };
}
