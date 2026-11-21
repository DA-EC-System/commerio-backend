// Đồng bộ cây category của sàn vào `channel.platform_categories` (#400, Documents/21 §18.5): việc nền
// `channel.category_sync`, mỗi sàn một lượt chờ, chạy mỗi đêm và khi bấm "Đồng bộ ngay". Lời gọi sàn chỉ tính trần chung
// (`appOnly`): cây là dữ liệu của nền tảng, không thuộc công ty nào (A4).
import { z } from 'zod';
import { defineQueue, findAccountById, schedulePlatform, sendJob } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { CategoryTreeShrunkError, oldestActiveShopOn, syncTree } from '../repository/platform-categories.ts';
import { appOnly, getAdapter, type PlatformCategoryNode, registeredPlatforms } from './marketplaces/index.ts';
import { platformOf, shopSession } from './shops.ts';

export const CategorySyncJobSchema = z.object({
  platform: z.string().max(40),
  companyId: z.uuid().optional(),
  /** Quản trị nền tảng cho phép ghi cây thiếu quá ngưỡng (`syncTree({ allowShrink })`). */
  allowShrink: z.boolean().optional(),
});
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
/**
 * Xếp một lượt (route `POST …/categories/sync`); `queued = false` khi sàn đã có lượt chờ. Lượt `allowShrink` dùng khoá riêng
 * (`<sàn>:allow-shrink`) để không bị nuốt vào lượt thường đang chờ (lượt thường không mang cờ).
 */
export async function requestCategorySync(
  raw: string,
  opts: { allowShrink?: boolean; accountId?: string } = {},
): Promise<{ queued: boolean }> {
  // Cờ quản trị nền tảng đọc từ DB mỗi lần (gỡ cờ là chặn ngay, như router `platform`); kiểm trước sàn, trước xếp việc.
  if (opts.allowShrink && !(opts.accountId && (await findAccountById(opts.accountId))?.isPlatformAdmin)) {
    throw new AppError(403, 'forbidden', 'Chỉ quản trị nền tảng được cho đồng bộ ghi cây thiếu');
  }
  const { platform, adapter } = platformOf(raw);
  if (!adapter.categoryTree) throw new AppError(422, 'marketplace_unsupported', 'Sàn này chưa hỗ trợ đọc category từ app');
  const job: CategorySyncJob = opts.allowShrink ? { platform, allowShrink: true } : { platform };
  return { queued: (await sendJob(categorySyncQueue, job, { key: opts.allowShrink ? `${platform}:allow-shrink` : platform })) !== null };
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
 * ghi (khỏi đánh `removed` cả sàn); cây thiếu bất thường (`CategoryTreeShrunkError`) log `error` rồi ném.
 * Mốc `synced_at` lấy **trước** khi đọc sàn: hai lượt chồng nhau thì lượt đọc sau thắng (review BE1 P2-4).
 * `borrowShop` thay được trong test (review BE1 P2-8: không phụ thuộc gian hàng của file khác trên DB dùng chung).
 */
export async function runCategorySync(
  job: CategorySyncJob,
  opts: { now?: () => Date; borrowShop?: typeof oldestActiveShopOn } = {},
): Promise<void> {
  const { now = () => new Date(), borrowShop = oldestActiveShopOn } = opts;
  const adapter = getAdapter(job.platform);
  if (!adapter?.categoryTree) return;
  const platform = job.platform;
  const startedAt = now();
  let nodes: PlatformCategoryNode[];
  if (adapter.categoriesNeedToken === false) {
    nodes = await appOnly(() => adapter.categoryTree!(null));
  } else {
    const shop = await borrowShop(platform);
    if (!shop) {
      logger.info({ platform }, 'đồng bộ cây category: sàn cần token mà không có gian hàng active, bỏ lượt');
      return;
    }
    nodes = await appOnly(async () => {
      const session = await withCompany(shop.companyId, () => shopSession(shop.id));
      return session.adapter.categoryTree!(session.accessToken);
    });
  }
  try {
    const result = await syncTree(platform, nodes, startedAt, { allowShrink: job.allowShrink === true });
    logger.info({ platform, ...result }, result.skipped ? 'đồng bộ cây category: đã có lượt mới hơn, bỏ' : 'đồng bộ cây category xong');
  } catch (err) {
    if (err instanceof CategoryTreeShrunkError) {
      logger.error(
        { platform, active: err.active, removing: err.removing, received: nodes.length },
        'đồng bộ cây category: cây thiếu bất thường, không ghi (removing: số node sắp bỏ, active: tổng node đang dùng); quản trị nền tảng chạy lại với allowShrink nếu sàn bỏ thật',
      );
    }
    throw err;
  }
}
