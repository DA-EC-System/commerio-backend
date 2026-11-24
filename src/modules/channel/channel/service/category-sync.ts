// Đồng bộ cây category của sàn vào `channel.platform_categories` (#400, Documents/21 §18.5): việc nền
// `channel.category_sync`, mỗi sàn một lượt chờ, chạy mỗi đêm và khi bấm "Đồng bộ ngay". Lời gọi sàn chỉ tính trần chung
// (`appOnly`): cây là dữ liệu của nền tảng, không thuộc công ty nào (A4).
import { z } from 'zod';
import { defineQueue, findAccountById, type JobAttempt, schedulePlatform, sendJob } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { borrowCandidates, setTreeSyncState } from '../repository/category-sync-state.ts';
import { CategoryTreeShrunkError, syncTree, treeSyncedAt } from '../repository/platform-categories.ts';
import { appOnly, getAdapter, MarketplaceError, type PlatformCategoryNode, registeredPlatforms } from './marketplaces/index.ts';
import { platformOf, shopSession, toAppError } from './shops.ts';

export const CategorySyncJobSchema = z.object({
  platform: z.string().max(40),
  companyId: z.uuid().optional(),
  /** Gian hàng vừa nối (#569, Documents/21 §18.5): mượn token sau mọi gian hàng `active` khi sàn cần token. */
  shopId: z.uuid().optional(),
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
  const queued = (await sendJob(categorySyncQueue, job, { key: opts.allowShrink ? `${platform}:allow-shrink` : platform })) !== null;
  if (queued) await setTreeSyncState(platform, 'queued');
  return { queued };
}

/**
 * Nối gian hàng xong (consumer `channel.shop_status_changed` `to = connecting`, Documents/21 §18.5 "Đồng bộ category khi nối
 * gian hàng"): sàn không đọc được cây thì `unsupported`; đã có cây thì thôi; chưa có thì xếp lượt mang `shopId` để mượn token
 * của chính gian hàng khi sàn chưa có gian hàng `active` nào. Không ném: lỗi ở đây không được làm hỏng việc nối.
 */
export async function ensureCategoryTree(platform: string, shopId: string): Promise<void> {
  const adapter = getAdapter(platform);
  if (!adapter?.categoryTree) {
    await setTreeSyncState(platform, 'unsupported');
    return;
  }
  if (await treeSyncedAt(platform)) return;
  const queued = (await sendJob(categorySyncQueue, { platform, shopId }, { key: platform })) !== null;
  if (queued) await setTreeSyncState(platform, 'queued');
}

/** Lịch đêm cho mọi sàn có adapter đọc được cây (worker gọi lúc khởi động). */
export async function scheduleCategorySync(): Promise<void> {
  for (const platform of registeredPlatforms()) {
    if (getAdapter(platform)?.categoryTree) await schedulePlatform(categorySyncQueue, CATEGORY_SYNC_CRON, { platform }, platform);
  }
}

/** Không còn gian hàng nào cho mượn token: lỗi cuối, không thử lại. */
class NoBorrowableShopError extends Error {}

/** Câu lỗi lưu ở trạng thái: câu của app (không token, không câu thô của sàn). */
function syncErrorText(err: unknown): string {
  if (err instanceof NoBorrowableShopError) return err.message;
  if (err instanceof CategoryTreeShrunkError) return 'Cây category sàn trả về thiếu bất thường, chưa ghi. Thử lại sau.';
  if (err instanceof MarketplaceError) return toAppError(err).message;
  if (err instanceof AppError) return err.message;
  return 'Đồng bộ category lỗi, thử lại sau.';
}

/** Đọc cây bằng token mượn: lần lượt từng gian hàng, sàn từ chối token hay gian hàng hết nối thì sang gian hàng kế. */
async function readWithBorrowedToken(
  platform: string,
  shopId: string | undefined,
  borrow: typeof borrowCandidates,
): Promise<PlatformCategoryNode[]> {
  for (const shop of await borrow(platform, shopId)) {
    try {
      return await appOnly(async () => {
        const session = await withCompany(shop.companyId, () => shopSession(shop.id));
        return session.adapter.categoryTree!(session.accessToken);
      });
    } catch (err) {
      const unauthorized = err instanceof MarketplaceError && err.kind === 'unauthorized';
      const notConnected = err instanceof AppError && err.code === 'shop_not_connected';
      if (!unauthorized && !notConnected) throw err;
      logger.warn({ platform, shopId: shop.id }, 'đồng bộ cây category: gian hàng không cho mượn token được, thử gian hàng kế');
    }
  }
  throw new NoBorrowableShopError('Chưa có gian hàng nào còn uỷ quyền để đọc category của sàn. Kết nối lại gian hàng rồi thử lại.');
}

/**
 * Một lượt: đọc cả cây rồi `syncTree` (ngoài `withCompany`). Sàn cần token (TikTok) mượn theo `borrowCandidates`: gian hàng
 * `active` cũ nhất trước, rồi gian hàng `shopId` của việc (đang nối); sàn từ chối token thì thử gian hàng kế, hết thì `failed`
 * (Documents/21 §18.5). Trạng thái trên `marketplaces`: `running` lúc bắt đầu, `idle` khi xong; lỗi còn lượt thử thì `queued`
 * kèm câu lỗi, lần cuối (hoặc lỗi không thử lại) thì `failed`. Cây rỗng là phản hồi lạ, không ghi (khỏi đánh `removed` cả
 * sàn); cây thiếu bất thường (`CategoryTreeShrunkError`) log `error` rồi ném.
 * Mốc `synced_at` lấy **trước** khi đọc sàn: hai lượt chồng nhau thì lượt đọc sau thắng (review BE1 P2-4).
 * `borrow` thay được trong test (review BE1 P2-8: không phụ thuộc gian hàng của file khác trên DB dùng chung).
 */
export async function runCategorySync(
  job: CategorySyncJob,
  attempt: Pick<JobAttempt, 'lastAttempt'> = { lastAttempt: false },
  opts: { now?: () => Date; borrow?: typeof borrowCandidates } = {},
): Promise<void> {
  const { now = () => new Date(), borrow = borrowCandidates } = opts;
  const adapter = getAdapter(job.platform);
  if (!adapter?.categoryTree) return;
  const platform = job.platform;
  const startedAt = now();
  await setTreeSyncState(platform, 'running');
  let nodes: PlatformCategoryNode[] = [];
  try {
    nodes =
      adapter.categoriesNeedToken === false
        ? await appOnly(() => adapter.categoryTree!(null))
        : await readWithBorrowedToken(platform, job.shopId, borrow);
    const result = await syncTree(platform, nodes, startedAt, { allowShrink: job.allowShrink === true });
    await setTreeSyncState(platform, 'idle');
    logger.info({ platform, ...result }, result.skipped ? 'đồng bộ cây category: đã có lượt mới hơn, bỏ' : 'đồng bộ cây category xong');
  } catch (err) {
    if (err instanceof CategoryTreeShrunkError) {
      logger.error(
        { platform, active: err.active, removing: err.removing, received: nodes.length },
        'đồng bộ cây category: cây thiếu bất thường, không ghi (removing: số node sắp bỏ, active: tổng node đang dùng); quản trị nền tảng chạy lại với allowShrink nếu sàn bỏ thật',
      );
    }
    const final = attempt.lastAttempt || err instanceof NoBorrowableShopError;
    await setTreeSyncState(platform, final ? 'failed' : 'queued', syncErrorText(err));
    if (err instanceof NoBorrowableShopError) {
      logger.warn({ platform }, 'đồng bộ cây category: không có gian hàng cho mượn token');
      return;
    }
    throw err;
  }
}
