// Cây category, attribute của leaf của sàn (bảng tham chiếu nền tảng, không RLS) và spec trỏ tới chúng (#400).
// Ghi hai bảng tham chiếu chỉ qua `replaceLeaf`, `syncTree`, chạy **ngoài** `withCompany`: `commerio_app` chỉ có `SELECT`
// (migration `*_category-san-quyen`), role chủ bảng ghi được (A3).
import { and, asc, eq, inArray, isNotNull, isNull, max, notInArray, or, sql } from 'drizzle-orm';
import { currentCompanyId, getDb, inTransaction } from '../../../../shared/db/client.ts';
import { normalizePath, type PlatformAttribute } from '../domain/product-spec.ts';
import {
  type Marketplace,
  platformCategories,
  platformCategoryAttributes,
  productSpecs,
  shops,
  type SizeChartRule,
  type SpecSource,
} from './schema.ts';

export type CategoryRow = typeof platformCategories.$inferSelect;

/** Node cây để ghi (`syncTree`): `path` nối tên từ gốc bằng " > ". */
export interface CategoryNodeInput {
  externalId: string;
  parentExternalId: string | null;
  name: string;
  isLeaf: boolean;
  path: string;
}

const SEARCH_LIMIT = 50;
const BATCH = 1000;

/**
 * Leaf `active` đã đồng bộ (`synced_at` khác null: bỏ dòng tạm của `replaceLeaf`) có `path_search` chứa gần đúng `q`
 * (`<%`, ngưỡng `pg_trgm.word_similarity_threshold`), xếp `word_similarity` giảm, rồi đường dẫn có dấu chứa nguyên `raw`
 * trước, rồi `path`. Không dùng `similarity()`: so cả chuỗi dài nên leaf đúng bị điểm thấp (review r1 #1).
 */
export async function searchLeaves(platform: Marketplace, raw: string): Promise<CategoryRow[]> {
  const q = normalizePath(raw);
  const exact = `%${raw.trim().toLocaleLowerCase('vi')}%`;
  return getDb()
    .select()
    .from(platformCategories)
    .where(
      and(
        eq(platformCategories.platform, platform),
        eq(platformCategories.isLeaf, true),
        eq(platformCategories.status, 'active'),
        sql`${platformCategories.syncedAt} is not null`,
        sql`${q} <% ${platformCategories.pathSearch}`,
      ),
    )
    .orderBy(
      sql`word_similarity(${q}, ${platformCategories.pathSearch}) desc`,
      sql`(lower(${platformCategories.path}) like ${exact}) desc`,
      asc(platformCategories.path),
    )
    .limit(SEARCH_LIMIT);
}

/** Con trực tiếp của `parentId`; null là cấp gốc. Gồm cả node `removed` (FE hiện nhãn). */
export async function childrenOf(platform: Marketplace, parentId: string | null): Promise<CategoryRow[]> {
  return getDb()
    .select()
    .from(platformCategories)
    .where(
      and(
        eq(platformCategories.platform, platform),
        parentId === null ? isNull(platformCategories.parentExternalId) : eq(platformCategories.parentExternalId, parentId),
        sql`${platformCategories.syncedAt} is not null`,
      ),
    )
    .orderBy(asc(platformCategories.name), asc(platformCategories.externalId));
}

/** Lần đồng bộ cây gần nhất của sàn; null khi sàn chưa có dòng nào đã đồng bộ. */
export async function treeSyncedAt(platform: Marketplace): Promise<Date | null> {
  const [row] = await getDb()
    .select({ at: max(platformCategories.syncedAt) })
    .from(platformCategories)
    .where(eq(platformCategories.platform, platform));
  return row?.at ?? null;
}

export async function findCategory(platform: Marketplace, externalId: string): Promise<CategoryRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(platformCategories)
    .where(and(eq(platformCategories.platform, platform), eq(platformCategories.externalId, externalId)));
  return row;
}

/** Attribute đã lưu của leaf: bắt buộc trước, thuộc tính sản phẩm trước sales, rồi theo nhãn. */
export async function leafAttributesOf(platform: Marketplace, externalId: string): Promise<PlatformAttribute[]> {
  const rows = await getDb()
    .select()
    .from(platformCategoryAttributes)
    .where(and(eq(platformCategoryAttributes.platform, platform), eq(platformCategoryAttributes.externalCategoryId, externalId)))
    .orderBy(
      sql`${platformCategoryAttributes.required} desc`,
      sql`(${platformCategoryAttributes.kind} = 'sales')`,
      asc(platformCategoryAttributes.label),
      asc(platformCategoryAttributes.code),
    );
  return rows.map((r) => {
    return {
      code: r.code,
      label: r.label,
      kind: r.kind,
      input: r.input,
      options: r.options,
      allowCustom: r.allowCustom,
      required: r.required,
      requiredWhen: r.requiredWhen,
      isKey: r.isKey,
      tier: r.tier,
      raw: r.raw,
    };
  });
}

/** Bảng tham chiếu không được ghi trong `withCompany` (role `commerio_app` chỉ đọc): báo lỗi lập trình sớm. */
function assertOutsideCompany(fn: string): void {
  if (currentCompanyId() !== null) throw new Error(`${fn} phải gọi ngoài withCompany (bảng tham chiếu của nền tảng)`);
}

/**
 * Thay cả tập attribute của một leaf trong một giao dịch (A3): xoá `code` sàn đã bỏ, upsert phần còn lại, ghi
 * `size_chart_rule`, `attributes_fetched_at` (leaf không có attribute nào cũng không gọi sàn lại trong 7 ngày). Leaf chưa
 * có dòng (leaf mới sau lượt đồng bộ đêm) thì chèn dòng tạm `synced_at = null` (tìm kiếm bỏ qua; lượt đồng bộ sau ghi đè).
 */
export async function replaceLeaf(
  platform: Marketplace,
  externalId: string,
  input: { attributes: PlatformAttribute[]; sizeChartRule: SizeChartRule | null; fetchedAt: Date },
): Promise<void> {
  assertOutsideCompany('replaceLeaf');
  await inTransaction(async (tx) => {
    await tx
      .insert(platformCategories)
      .values({ platform, externalId, name: externalId, isLeaf: true, path: externalId, pathSearch: normalizePath(externalId) })
      .onConflictDoNothing();
    const codes = input.attributes.map((a) => a.code);
    await tx
      .delete(platformCategoryAttributes)
      .where(
        and(
          eq(platformCategoryAttributes.platform, platform),
          eq(platformCategoryAttributes.externalCategoryId, externalId),
          codes.length ? notInArray(platformCategoryAttributes.code, codes) : undefined,
        ),
      );
    if (input.attributes.length) {
      await tx
        .insert(platformCategoryAttributes)
        .values(
          input.attributes.map((a) => ({
            platform,
            externalCategoryId: externalId,
            code: a.code,
            label: a.label,
            kind: a.kind,
            input: a.input,
            options: a.options,
            allowCustom: a.allowCustom,
            required: a.required,
            requiredWhen: a.requiredWhen,
            isKey: a.isKey,
            tier: a.tier,
            raw: a.raw,
            fetchedAt: input.fetchedAt,
          })),
        )
        .onConflictDoUpdate({
          target: [platformCategoryAttributes.platform, platformCategoryAttributes.externalCategoryId, platformCategoryAttributes.code],
          set: {
            label: sql`excluded.label`,
            kind: sql`excluded.kind`,
            input: sql`excluded.input`,
            options: sql`excluded.options`,
            allowCustom: sql`excluded.allow_custom`,
            required: sql`excluded.required`,
            requiredWhen: sql`excluded.required_when`,
            isKey: sql`excluded.is_key`,
            tier: sql`excluded.tier`,
            raw: sql`excluded.raw`,
            fetchedAt: sql`excluded.fetched_at`,
          },
        });
    }
    await tx
      .update(platformCategories)
      .set({ sizeChartRule: input.sizeChartRule, attributesFetchedAt: input.fetchedAt })
      .where(and(eq(platformCategories.platform, platform), eq(platformCategories.externalId, externalId)));
  });
}

/**
 * Ghi cả cây của sàn trong một giao dịch: upsert mọi node (`active`, `synced_at = syncedAt`), node vắng trong cây
 * (kể cả dòng tạm) → `removed`, spec mọi công ty trỏ tới node vừa `removed` → `category_status = 'removed'`. Không xoá
 * dòng nào (attribute, spec, listing còn trỏ tới). Trả số node bị đánh `removed`, số spec đổi.
 */
export async function syncTree(
  platform: Marketplace,
  nodes: readonly CategoryNodeInput[],
  syncedAt: Date,
): Promise<{ upserted: number; removed: number; specsRemoved: number }> {
  assertOutsideCompany('syncTree');
  if (!nodes.length) throw new Error('syncTree: cây rỗng, không ghi để khỏi đánh removed cả sàn');
  return inTransaction(async (tx) => {
    for (let i = 0; i < nodes.length; i += BATCH) {
      await tx
        .insert(platformCategories)
        .values(
          nodes.slice(i, i + BATCH).map((n) => ({
            platform,
            externalId: n.externalId,
            parentExternalId: n.parentExternalId,
            name: n.name,
            isLeaf: n.isLeaf,
            path: n.path,
            pathSearch: normalizePath(n.path),
            status: 'active' as const,
            syncedAt,
          })),
        )
        .onConflictDoUpdate({
          target: [platformCategories.platform, platformCategories.externalId],
          set: {
            parentExternalId: sql`excluded.parent_external_id`,
            name: sql`excluded.name`,
            isLeaf: sql`excluded.is_leaf`,
            path: sql`excluded.path`,
            pathSearch: sql`excluded.path_search`,
            status: sql`excluded.status`,
            syncedAt: sql`excluded.synced_at`,
          },
        });
    }
    const removed = await tx
      .update(platformCategories)
      .set({ status: 'removed' })
      .where(
        and(
          eq(platformCategories.platform, platform),
          eq(platformCategories.status, 'active'),
          or(isNull(platformCategories.syncedAt), sql`${platformCategories.syncedAt} < ${syncedAt}`),
        ),
      )
      .returning({ externalId: platformCategories.externalId });
    let specsRemoved = 0;
    const ids = removed.map((r) => r.externalId);
    for (let i = 0; i < ids.length; i += BATCH) {
      const changed = await tx
        .update(productSpecs)
        .set({ categoryStatus: 'removed', updatedAt: syncedAt })
        .where(
          and(
            eq(productSpecs.platform, platform),
            inArray(productSpecs.externalCategoryId, ids.slice(i, i + BATCH)),
            sql`${productSpecs.categoryStatus} <> 'removed'`,
          ),
        )
        .returning({ id: productSpecs.id });
      specsRemoved += changed.length;
    }
    return { upserted: nodes.length, removed: ids.length, specsRemoved };
  });
}

/** Spec của công ty (RLS, gọi trong `withCompany`) trỏ tới một leaf: cho danh sách `products` của chi tiết leaf. */
export async function specsOnCategory(platform: Marketplace, externalId: string): Promise<{ productId: string; source: SpecSource }[]> {
  return getDb()
    .select({ productId: productSpecs.productId, source: productSpecs.source })
    .from(productSpecs)
    .where(and(eq(productSpecs.platform, platform), eq(productSpecs.externalCategoryId, externalId)))
    .orderBy(asc(productSpecs.createdAt));
}

/** Gian hàng `active` còn token, nối sớm nhất trên sàn, mọi công ty (lượt đồng bộ cây mượn token, A4). Gọi ngoài `withCompany`. */
export async function oldestActiveShopOn(platform: Marketplace): Promise<{ id: string; companyId: string } | undefined> {
  const [row] = await getDb()
    .select({ id: shops.id, companyId: shops.companyId })
    .from(shops)
    .where(and(eq(shops.platform, platform), eq(shops.status, 'active'), isNotNull(shops.accessTokenEnc)))
    .orderBy(asc(shops.createdAt), asc(shops.id))
    .limit(1);
  return row;
}
