// Đọc chéo core, product, channel qua cổng công khai (Documents/21 mục 11.3), trong một `withCompany`.
import { inTransaction, withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { shopSetupState } from '../../../channel/index.ts';
import { companyProfileFilled, markOnboardingCompleted, onboardingCompletedAt, teamSetupState } from '../../../core/index.ts';
import { hasCatalogData, openingStockState } from '../../../product/index.ts';
import { missingRequired, type Onboarding, type OnboardingFacts, onboardingItems } from '../domain/items.ts';

/** `reportEnabled`: lấy từ ngữ cảnh truy cập của người gọi (phân hệ đang bật), không cần cổng đọc thêm. */
async function factsOf(companyId: string, reportEnabled: boolean): Promise<OnboardingFacts> {
  // Tuần tự: cùng một kết nối của giao dịch, chạy song song cũng xếp hàng ở pg.
  const facts = await withCompany(companyId, async () => ({
    profileFilled: await companyProfileFilled(),
    team: await teamSetupState(),
    shops: await shopSetupState(),
    hasProduct: await hasCatalogData(),
    opening: await openingStockState(),
    completedAt: await onboardingCompletedAt(),
  }));
  return { ...facts, reportEnabled };
}

/** `GET /onboarding`: không ghi gì (gọi lại, prefetch, cache đều an toàn). */
export async function getOnboarding(
  companyId: string,
  can: (permission: string) => boolean,
  reportEnabled: boolean,
): Promise<Onboarding> {
  return onboardingItems(await factsOf(companyId, reportEnabled), can);
}

/**
 * `POST /onboarding/complete` (Documents/21 mục 23): đã có mốc thì trả mốc cũ, không kiểm lại các mục. Chưa có thì tính
 * lại mọi mục bắt buộc của công ty, không lọc theo quyền; còn mục chưa xong thì 409 `onboarding_incomplete` kèm `missing`,
 * không ghi gì. Đủ thì đặt mốc qua cổng core (một lần; nhật ký chỉ khi đổi đúng một dòng, hai lời gọi đua chỉ một dòng).
 */
export async function completeOnboarding(companyId: string, actorId: string): Promise<{ completedAt: string }> {
  const facts = await factsOf(companyId, false);
  if (facts.completedAt) return { completedAt: facts.completedAt };
  const missing = missingRequired(facts);
  if (missing.length) {
    throw new AppError(409, 'onboarding_incomplete', 'Còn bước thiết lập bắt buộc chưa xong', { missing });
  }
  // Ngoài `withCompany`: `commerio_app` không có UPDATE trên `core.companies`.
  const { completedAt } = await inTransaction(() => markOnboardingCompleted({ companyId, actorId }));
  return { completedAt };
}
