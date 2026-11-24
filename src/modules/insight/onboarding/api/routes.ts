import { Router } from 'express';
import { getAuth } from '../../../../shared/auth/authenticate.ts';
import { getAccess, moduleOfPermission } from '../../../../shared/auth/authorize.ts';
import type { ModuleContext } from '../../../../shared/module.ts';
import { COMPLETE_PERMISSION } from '../domain/items.ts';
import { completeOnboarding, getOnboarding } from '../service/onboarding.ts';

/** Route của module `onboarding`, gắn tại /api/v1/onboarding (Documents/21 mục 23). */
export function onboardingRouter({ member, authorize }: ModuleContext): Router {
  const router = Router();

  // Mọi thành viên gọi được; mỗi mục lọc theo quyền có hiệu lực (quyền của phân hệ đang tắt không tính, mục 13.2).
  // Không gắn `report.*`: Báo cáo là phân hệ tuỳ chọn, tắt thì Tổng quan không được 403.
  router.get('/', member, async (_req, res) => {
    const { permissions, enabledModules } = getAccess(res);
    const can = (p: string) => permissions.includes(p) && enabledModules.includes(moduleOfPermission(p));
    res.json(await getOnboarding(getAuth(res).companyId!, can, enabledModules.includes('report')));
  });

  // Nút "Vào Tổng quan" của trang "Sẵn sàng bán": quyền của mục bắt buộc đầu tiên, để người bị giữ ở trang đó luôn bấm được.
  router.post('/complete', authorize(COMPLETE_PERMISSION), async (_req, res) => {
    const { companyId, accountId } = getAuth(res);
    res.json(await completeOnboarding(companyId!, accountId));
  });

  return router;
}
