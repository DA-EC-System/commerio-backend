// Quyền category theo gian hàng khi nối (#569, Documents/21 §18.5 "Đồng bộ category khi nối gian hàng"): sàn khai
// `categoryPermissionsPerShop` (TikTok) thì đọc cây bằng token của chính gian hàng, ghi mọi leaf vào
// `shop_category_permissions`. Lời gọi tính vào hạn mức của công ty (khác cây chung của sàn, `appOnly`).
import { z } from 'zod';
import { defineQueue, type JobAttempt, sendJob } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { permissionOf } from '../domain/product-spec.ts';
import { setPermissionsState, shopOwnerOf } from '../repository/category-sync-state.ts';
import { upsertPermissions } from '../repository/product-specs.ts';
import { findShopRow } from '../repository/shops.ts';
import { ensureCategoryTree } from './category-sync.ts';
import { type CategorySyncStatus, categorySyncStatus } from './category-sync-status.ts';
import { getAdapter, MarketplaceError } from './marketplaces/index.ts';
import { shopSession, toAppError } from './shops.ts';

export const PermissionsSyncJobSchema = z.object({ shopId: z.uuid(), companyId: z.uuid() });
export type PermissionsSyncJob = z.infer<typeof PermissionsSyncJobSchema>;

/** Một gian hàng một lượt chờ (khoá là id gian hàng). Cây TikTok hơn 7000 node: 30 phút, thử 3 lần. */
export const permissionsSyncQueue = defineQueue('channel.shop_category_permissions_sync', PermissionsSyncJobSchema, {
  policy: 'stately',
  attempts: 3,
  retryDelaySeconds: 120,
  expireInSeconds: 1800,
});

/**
 * Consumer `channel.shop_status_changed`: gian hàng vào `connecting` (nối mới, nối lại khi chưa thiết lập) thì bảo đảm sàn
 * có cây category và, với sàn có quyền theo gian hàng, xếp lượt đọc quyền. Chạy sau khi giao dịch nối đã commit (outbox).
 */
export async function onShopConnecting(payload: { shopId: string; to: string }): Promise<void> {
  if (payload.to !== 'connecting') return;
  const owner = await shopOwnerOf(payload.shopId);
  if (!owner) return;
  await ensureCategoryTree(owner.platform, payload.shopId);
  const adapter = getAdapter(owner.platform);
  if (!adapter?.categoryPermissionsPerShop || !adapter.categoryTree) return;
  const job = { shopId: payload.shopId, companyId: owner.companyId };
  if ((await sendJob(permissionsSyncQueue, job, { key: payload.shopId })) !== null) {
    await withCompany(owner.companyId, () => setPermissionsState(payload.shopId, 'queued'));
  }
}

/**
 * Nút Thử lại của quyền category (`POST /shops/:id/category-permissions/refresh`, #569, Documents/21 §18.5): xếp lại lượt đọc
 * quyền, trả trạng thái như `GET …/category-sync`. 404 → 422 `marketplace_unsupported` (sàn không có quyền theo gian hàng) →
 * 409 `shop_not_connected` (gian hàng không `connecting`/`active` hoặc hết token). Đã có lượt chờ thì không xếp thêm.
 */
export async function requestPermissionsRefresh(companyId: string, shopId: string): Promise<CategorySyncStatus> {
  const shop = await withCompany(companyId, () => findShopRow(shopId));
  if (!shop) throw new AppError(404, 'not_found', 'Không tìm thấy gian hàng');
  const adapter = getAdapter(shop.platform);
  if (!adapter?.categoryPermissionsPerShop || !adapter.categoryTree) {
    throw new AppError(422, 'marketplace_unsupported', 'Sàn này không có quyền category theo gian hàng');
  }
  if ((shop.status !== 'connecting' && shop.status !== 'active') || !shop.accessTokenEnc) {
    throw new AppError(409, 'shop_not_connected', 'Gian hàng chưa kết nối hoặc cần kết nối lại', { current: shop.status });
  }
  if ((await sendJob(permissionsSyncQueue, { shopId, companyId }, { key: shopId })) !== null) {
    await withCompany(companyId, () => setPermissionsState(shopId, 'queued'));
  }
  return categorySyncStatus(companyId, shopId);
}

function errorText(err: unknown): string {
  if (err instanceof MarketplaceError) return toAppError(err).message;
  if (err instanceof AppError) return err.message;
  return 'Đọc quyền category của gian hàng lỗi, thử lại sau.';
}

/**
 * Một lượt: `running` → đọc cây bằng token gian hàng → ghi quyền mọi leaf (mốc lấy trước lời gọi) → `ready`. Lỗi còn lượt thử
 * thì `queued` kèm câu lỗi và ném; lần cuối, hoặc gian hàng không còn gọi được sàn (ngắt, mất uỷ quyền), thì `failed`.
 */
export async function runPermissionsSync(job: PermissionsSyncJob, attempt: Pick<JobAttempt, 'lastAttempt'> = { lastAttempt: false }): Promise<void> {
  const { shopId, companyId } = job;
  const inCompany = <T>(fn: () => Promise<T>) => withCompany(companyId, fn);
  const startedAt = new Date();
  await inCompany(() => setPermissionsState(shopId, 'running'));
  try {
    const session = await inCompany(() => shopSession(shopId));
    if (!session.adapter.categoryPermissionsPerShop || !session.adapter.categoryTree) {
      await inCompany(() => setPermissionsState(shopId, 'ready', null, startedAt));
      return;
    }
    const nodes = await session.adapter.categoryTree(session.accessToken);
    const items = nodes.flatMap((n) => {
      const status = n.isLeaf && n.permissionStatuses ? permissionOf(n.permissionStatuses) : null;
      return status ? [{ externalCategoryId: n.externalId, status }] : [];
    });
    await inCompany(async () => {
      await upsertPermissions(companyId, shopId, items, startedAt);
      await setPermissionsState(shopId, 'ready', null, startedAt);
    });
    logger.info({ shopId, leaves: items.length }, 'đọc quyền category của gian hàng xong');
  } catch (err) {
    const gone = (err instanceof AppError && err.code === 'shop_not_connected') || (err instanceof MarketplaceError && err.kind === 'unauthorized');
    const final = attempt.lastAttempt || gone;
    await inCompany(() => setPermissionsState(shopId, final ? 'failed' : 'queued', errorText(err)));
    if (gone) {
      logger.warn({ shopId }, 'đọc quyền category: gian hàng không gọi được sàn, dừng');
      return;
    }
    throw err;
  }
}
