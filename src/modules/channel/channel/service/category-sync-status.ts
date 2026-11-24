// Trạng thái đồng bộ category cho màn nối gian hàng (#569, `GET /channel/shops/:id/category-sync`, Documents/21 §18.5).
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { availablePermissionCount, permissionsStateOf, treeSyncStateOf } from '../repository/category-sync-state.ts';
import { lastPermissionCheck } from '../repository/product-specs.ts';
import { findShopRow } from '../repository/shops.ts';
import { getAdapter } from './marketplaces/index.ts';

export type TreeState = 'ready' | 'queued' | 'running' | 'failed' | 'unsupported';
export type PermissionsState = 'ready' | 'queued' | 'running' | 'failed';

export interface CategorySyncStatus {
  tree: { state: TreeState; syncedAt: string | null; leafCount: number; error: string | null };
  permissions: { state: PermissionsState; checkedAt: string | null; availableCount: number; error: string | null } | null;
}

/** Sàn rảnh mà chưa từng có cây (lượt đầu bị mất, hay đồng bộ trước #569): báo lỗi để FE hiện nút Thử lại. */
export const TREE_MISSING = 'Chưa có cây category của sàn. Bấm Thử lại để đồng bộ.';
/** Gian hàng chưa có lượt đọc quyền nào (nối trước #569, hoặc lượt bị mất). */
export const PERMISSIONS_MISSING = 'Chưa đọc quyền category của gian hàng. Bấm Thử lại để đọc.';

export async function categorySyncStatus(companyId: string, shopId: string): Promise<CategorySyncStatus> {
  return withCompany(companyId, async () => {
    const shop = await findShopRow(shopId);
    if (!shop) throw new AppError(404, 'not_found', 'Không tìm thấy gian hàng');
    const adapter = getAdapter(shop.platform);
    const tree = await treeSyncStateOf(shop.platform);
    const syncedAt = tree.syncedAt?.toISOString() ?? null;
    let treeView: CategorySyncStatus['tree'];
    if (!adapter?.categoryTree) treeView = { state: 'unsupported', syncedAt: null, leafCount: 0, error: null };
    else if (tree.state === 'idle' || tree.state === 'unsupported') {
      treeView = syncedAt
        ? { state: 'ready', syncedAt, leafCount: tree.leafCount, error: null }
        : { state: 'failed', syncedAt: null, leafCount: 0, error: tree.error ?? TREE_MISSING };
    } else treeView = { state: tree.state, syncedAt, leafCount: tree.leafCount, error: tree.error };

    if (!adapter?.categoryPermissionsPerShop) return { tree: treeView, permissions: null };
    const perm = await permissionsStateOf(shopId);
    const checked = perm?.checkedAt ?? (await lastPermissionCheck(shopId));
    const checkedAt = checked?.toISOString() ?? null;
    const availableCount = await availablePermissionCount(shopId);
    const state: PermissionsState = perm?.state ?? (checked ? 'ready' : 'failed');
    const error = perm?.state ? (perm.error ?? null) : checked ? null : PERMISSIONS_MISSING;
    return { tree: treeView, permissions: { state, checkedAt, availableCount, error } };
  });
}
