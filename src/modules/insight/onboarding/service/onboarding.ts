// Đọc chéo core, product, channel qua cổng công khai (Documents/21 mục 11.3), trong một `withCompany`.
import { withCompany } from '../../../../shared/db/client.ts';
import { shopSetupState } from '../../../channel/index.ts';
import { companyProfileFilled, teamSetupState } from '../../../core/index.ts';
import { hasCatalogData, openingStockState } from '../../../product/index.ts';
import { type Onboarding, onboardingItems } from '../domain/items.ts';

/** `reportEnabled`: lấy từ ngữ cảnh truy cập của người gọi (phân hệ đang bật), không cần cổng đọc thêm. */
export async function getOnboarding(
  companyId: string,
  can: (permission: string) => boolean,
  reportEnabled: boolean,
): Promise<Onboarding> {
  // Tuần tự: cùng một kết nối của giao dịch, chạy song song cũng xếp hàng ở pg.
  const facts = await withCompany(companyId, async () => ({
    profileFilled: await companyProfileFilled(),
    team: await teamSetupState(),
    shops: await shopSetupState(),
    hasProduct: await hasCatalogData(),
    opening: await openingStockState(),
  }));
  return onboardingItems({ ...facts, reportEnabled }, can);
}
