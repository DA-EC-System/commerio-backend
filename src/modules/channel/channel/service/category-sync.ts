// Đồng bộ cây category của sàn vào `channel.platform_categories` (#400, Documents/21 §18.5): việc nền
// `channel.category_sync`, mỗi sàn một lượt chờ, chạy mỗi đêm và khi bấm "Đồng bộ ngay". Lời gọi sàn chỉ tính trần chung
// (`appOnly`): cây là dữ liệu của nền tảng, không thuộc công ty nào (A4).
import { z } from 'zod';
import { defineQueue, schedulePlatform, sendJob } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { oldestActiveShopOn, syncTree } from '../repository/platform-categories.ts';
import { isMarketplace } from '../repository/schema.ts';
import { appOnly, getAdapter, type PlatformCategoryNode, registeredPlatforms } from './marketplaces/index.ts';
import { platformOf, shopSession } from './shops.ts';

export const CategorySyncJobSchema = z.object({ platform: z.string().max(40), companyId: z.uuid().optional() });
export type CategorySyncJob = z.infer<typeof CategorySyncJobSchema>;

/**
 * Một sàn một lượt chờ (`stately`, khoá là mã sàn). Cây TikTok hơn 7000 node, Lazada vài nghìn: cho chạy 30 phút, thử 3
 * lần (lỗi tạm của sàn).
 */
export const categorySyncQueue = defineQueue('channel.category_sync', CategorySyncJobSchema, {
  policy: 'stately',
  attempts: 3,
  retryDelaySeconds: 300,
  expireInSeconds: 1800,
});

/** 2 giờ 30 sáng giờ VN, ngoài giờ bán. */
const CATEGORY_SYNC_CRON = '30 2 * * *';

/** Xếp một lượt (route `POST …/categories/sync`); `queued = false` khi sàn đã có lượt chờ. */
export async function requestCategorySync(raw: string): Promise<{ queued: boolean }> {
  const { platform, adapter } = platformOf(raw);
  if (!adapter.categoryTree) throw new AppError(422, 'marketplace_unsupported', 'Sàn này chưa hỗ trợ đọc category từ app');
  return { queued: (await sendJob(categorySyncQueue, { platform }, { key: platform })) !== null };
}

/** Lịch đêm cho mọi sàn có adapter đọc được cây (worker gọi lúc khởi động). */
export async function scheduleCategorySync(): Promise<void> {
  for (const platform of registeredPlatforms()) {
    if (getAdapter(platform)?.categoryTree) await schedulePlatform(categorySyncQueue, CATEGORY_SYNC_CRON, { platform }, platform);
  }
}

/**
 * Một lượt: đọc cả cây rồi `syncTree` (ngoài `withCompany`). Sàn cần token (TikTok) mượn phiên gian hàng `active` cũ nhất
 * trên sàn (giữ lớp làm mới token), không có thì bỏ lượt. Lỗi sàn ném để pg-boss thử lại; cây rỗng là phản hồi lạ, không
 * ghi (khỏi đánh `removed` cả sàn).
 */
export async function runCategorySync(job: CategorySyncJob, now: () => Date = () => new Date()): Promise<void> {
  const adapter = getAdapter(job.platform);
  if (!adapter?.categoryTree || !isMarketplace(job.platform)) return;
  const platform = job.platform;
  let nodes: PlatformCategoryNode[];
  if (adapter.categoriesNeedToken === false) {
    nodes = await appOnly(() => adapter.categoryTree!(null));
  } else {
    const shop = await oldestActiveShopOn(platform);
    if (!shop) {
      logger.info({ platform }, 'đồng bộ cây category: sàn cần token mà không có gian hàng active, bỏ lượt');
      return;
    }
    nodes = await appOnly(async () => {
      const session = await withCompany(shop.companyId, () => shopSession(shop.id));
      return session.adapter.categoryTree!(session.accessToken);
    });
  }
  const startedAt = now();
  const result = await syncTree(platform, nodes, startedAt);
  logger.info({ platform, ...result }, 'đồng bộ cây category xong');
}
