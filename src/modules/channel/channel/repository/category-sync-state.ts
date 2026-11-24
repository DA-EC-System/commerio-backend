// Trạng thái đồng bộ category khi nối gian hàng và ánh xạ category sàn sang danh mục chuẩn (#569, Documents/21 §18.5).
// Cây của sàn và bảng ánh xạ là dữ liệu của nền tảng: ghi bằng role chủ bảng ngoài `withCompany`. Trạng thái quyền theo gian
// hàng nằm trên dòng `shops`, ghi trong `withCompany` của công ty sở hữu gian hàng.
import { and, asc, count, eq, inArray, isNotNull, max, or, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import {
  type CategoryPermissionsState,
  type CategoryTreeSyncState,
  type Marketplace,
  marketplaces,
  platformCategories,
  platformCategoryGroupMaps,
  shopCategoryPermissions,
  shops,
} from './schema.ts';
import { pathIdsOf } from './platform-categories.ts';

/** Câu lỗi lưu ở cột trạng thái: cắt gọn để một câu thô dài của sàn không phình dòng. */
const ERROR_MAX = 500;
const clip = (error: string | null) => (error === null ? null : error.slice(0, ERROR_MAX));

export async function setTreeSyncState(platform: Marketplace, state: CategoryTreeSyncState, error: string | null = null): Promise<void> {
  await getDb()
    .update(marketplaces)
    .set({ categorySyncState: state, categorySyncError: clip(error), categorySyncAt: sql`now()` })
    .where(eq(marketplaces.code, platform));
}

export async function treeSyncStateOf(
  platform: Marketplace,
): Promise<{ state: CategoryTreeSyncState; error: string | null; syncedAt: Date | null; leafCount: number }> {
  const [row] = await getDb()
    .select({ state: marketplaces.categorySyncState, error: marketplaces.categorySyncError })
    .from(marketplaces)
    .where(eq(marketplaces.code, platform));
  const [tree] = await getDb()
    .select({
      syncedAt: max(platformCategories.syncedAt),
      leafCount: sql<number>`(count(*) filter (where ${platformCategories.isLeaf} and ${platformCategories.status} = 'active' and ${platformCategories.syncedAt} is not null))::int`,
    })
    .from(platformCategories)
    .where(eq(platformCategories.platform, platform));
  return {
    state: row?.state ?? 'idle',
    error: row?.error ?? null,
    syncedAt: tree?.syncedAt ? new Date(tree.syncedAt) : null,
    leafCount: tree?.leafCount ?? 0,
  };
}

/**
 * Gian hàng cho mượn token để đọc cây, theo thứ tự của Documents/21 §18.5 (route sync): mọi gian hàng `active` còn token của
 * sàn, cũ nhất trước; rồi gian hàng `shopId` việc mang theo nếu đang `connecting` còn token. Bên gọi gặp lỗi uỷ quyền thì thử
 * gian hàng kế. Đọc ngoài `withCompany` (role chủ bảng, như `oldestActiveShopOn`).
 */
export async function borrowCandidates(platform: Marketplace, shopId?: string): Promise<{ id: string; companyId: string }[]> {
  const rows = await getDb()
    .select({ id: shops.id, companyId: shops.companyId, status: shops.status })
    .from(shops)
    .where(
      and(
        eq(shops.platform, platform),
        isNotNull(shops.accessTokenEnc),
        or(eq(shops.status, 'active'), shopId ? and(eq(shops.id, shopId), eq(shops.status, 'connecting')) : sql`false`),
      ),
    )
    .orderBy(asc(shops.createdAt), asc(shops.id));
  // `active` trước, gian hàng vừa nối sau cùng (thứ tự cũ nhất giữ trong từng nhóm)
  return [...rows.filter((r) => r.status === 'active'), ...rows.filter((r) => r.status !== 'active')].map(({ id, companyId }) => ({
    id,
    companyId,
  }));
}

/** Gọi trong `withCompany` của công ty sở hữu gian hàng. `checkedAt` chỉ đặt khi lượt đọc quyền xong. */
export async function setPermissionsState(
  shopId: string,
  state: CategoryPermissionsState,
  error: string | null = null,
  checkedAt?: Date,
): Promise<void> {
  await getDb()
    .update(shops)
    .set({
      categoryPermissionsState: state,
      categoryPermissionsError: clip(error),
      ...(checkedAt && { categoryPermissionsCheckedAt: checkedAt }),
    })
    .where(eq(shops.id, shopId));
}

/** Số leaf gian hàng được bán (`available`). Gọi trong `withCompany`. */
export async function availablePermissionCount(shopId: string): Promise<number> {
  const [row] = await getDb()
    .select({ n: count() })
    .from(shopCategoryPermissions)
    .where(and(eq(shopCategoryPermissions.shopId, shopId), eq(shopCategoryPermissions.status, 'available')));
  return row?.n ?? 0;
}

/**
 * Danh mục chuẩn gợi ý cho từng category sàn: đi từ category lên gốc theo cây đã đồng bộ (`pathIdsOf`), lấy dòng sâu nhất có
 * trong `platform_category_group_maps`. Category không có trong cây hoặc không nhánh nào ánh xạ thì vắng mặt. Chưa lọc danh mục
 * đã xoá hay bị công ty ẩn (bên gọi lọc qua catalog).
 */
export async function mappedGroupsOf(platform: Marketplace, externalCategoryIds: readonly string[]): Promise<Map<string, string>> {
  const paths = await pathIdsOf(platform, externalCategoryIds);
  const all = [...new Set([...paths.values()].flat())];
  if (!all.length) return new Map();
  const rows = await getDb()
    .select({ id: platformCategoryGroupMaps.externalCategoryId, groupId: platformCategoryGroupMaps.groupId })
    .from(platformCategoryGroupMaps)
    .where(and(eq(platformCategoryGroupMaps.platform, platform), inArray(platformCategoryGroupMaps.externalCategoryId, all)));
  const byId = new Map(rows.map((r) => [r.id, r.groupId]));
  const result = new Map<string, string>();
  for (const [origin, chain] of paths) {
    // `chain` đi từ gốc xuống chính category: duyệt ngược để lấy dòng sâu nhất
    const hit = [...chain].reverse().find((id) => byId.has(id));
    if (hit) result.set(origin, byId.get(hit)!);
  }
  return result;
}

/** Sàn, công ty của gian hàng, đọc ngoài `withCompany` (consumer chưa biết công ty). */
export async function shopOwnerOf(shopId: string): Promise<{ platform: Marketplace; companyId: string } | undefined> {
  const [row] = await getDb().select({ platform: shops.platform, companyId: shops.companyId }).from(shops).where(eq(shops.id, shopId));
  return row;
}

/** Trạng thái đọc quyền category của gian hàng. Gọi trong `withCompany`. */
export async function permissionsStateOf(
  shopId: string,
): Promise<{ state: CategoryPermissionsState | null; error: string | null; checkedAt: Date | null } | undefined> {
  const [row] = await getDb()
    .select({
      state: shops.categoryPermissionsState,
      error: shops.categoryPermissionsError,
      checkedAt: shops.categoryPermissionsCheckedAt,
    })
    .from(shops)
    .where(eq(shops.id, shopId));
  return row;
}
