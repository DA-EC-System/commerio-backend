// Cây category, attribute của leaf của sàn (bảng tham chiếu nền tảng, không RLS) và spec trỏ tới chúng (#400).
// Ghi hai bảng tham chiếu chỉ qua `replaceLeaf`, `syncTree`, chạy **ngoài** `withCompany`: `commerio_app` chỉ có `SELECT`
// (migration `*_category-san-quyen`), role chủ bảng ghi được (A3).
import { and, asc, eq, inArray, isNotNull, isNull, max, notInArray, or, sql } from 'drizzle-orm';
import { currentCompanyId, getDb, inTransaction } from '../../../../shared/db/client.ts';
import { normalizePath, type PlatformAttribute, treeShrinkBlocked } from '../domain/product-spec.ts';
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
 * `sizeChartRule` `undefined` (sàn không có luật, hay hỏi luật lỗi tạm) giữ giá trị đang có; chỉ ghi null khi sàn nói rõ
 * (review BE1 P2-2: không xoá luật đã biết, kể cả giá trị migration chép từ ghép danh mục cũ).
 */
export async function replaceLeaf(
  platform: Marketplace,
  externalId: string,
  input: { attributes: PlatformAttribute[]; sizeChartRule?: SizeChartRule | null; fetchedAt: Date },
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
      .set({ ...(input.sizeChartRule !== undefined && { sizeChartRule: input.sizeChartRule }), attributesFetchedAt: input.fetchedAt })
      .where(and(eq(platformCategories.platform, platform), eq(platformCategories.externalId, externalId)));
  });
}

/** Lượt đồng bộ sắp đánh `removed` quá ngưỡng `treeShrinkBlocked` (review BE1 P2-3): không ghi gì, việc nền log `error`. */
export class CategoryTreeShrunkError extends Error {
  readonly platform: Marketplace;
  readonly active: number;
  readonly removing: number;

  constructor(platform: Marketplace, active: number, removing: number) {
    super(`syncTree: cây ${platform} thiếu bất thường (bỏ ${removing}/${active} node active), không ghi`);
    this.name = 'CategoryTreeShrunkError';
    this.platform = platform;
    this.active = active;
    this.removing = removing;
  }
}

export interface SyncTreeResult {
  upserted: number;
  removed: number;
  specsRemoved: number;
  specsRestored: number;
  /** Đã có lượt ghi mới hơn `syncedAt` (hai lượt chồng nhau): lượt này không ghi gì. */
  skipped: boolean;
}

/**
 * Ghi cả cây của sàn trong một giao dịch: upsert mọi node (`active`, `synced_at = syncedAt`), node vắng trong cây
 * (kể cả dòng tạm) → `removed`, spec mọi công ty trỏ tới node vừa `removed` → `category_status = 'removed'`, spec
 * `removed` trỏ tới node `active` (category quay lại) → `ok`. Không xoá dòng nào (attribute, spec, listing còn trỏ tới).
 *
 * Chốt (review BE1 P2-3, P2-4): `nodes` khử trùng theo `externalId` (sàn trả trùng mã trong một lô làm hỏng
 * `ON CONFLICT`); khoá advisory theo sàn trong giao dịch, đã có `synced_at` mới hơn `syncedAt` thì bỏ cả lượt (lượt cũ
 * commit sau không kéo cây lùi, `synced_at` chỉ tiến); số node sắp `removed` vượt `treeShrinkBlocked` thì ném
 * `CategoryTreeShrunkError` (trừ `allowShrink`).
 */
export async function syncTree(
  platform: Marketplace,
  nodes: readonly CategoryNodeInput[],
  syncedAt: Date,
  opts: { allowShrink?: boolean } = {},
): Promise<SyncTreeResult> {
  assertOutsideCompany('syncTree');
  const unique = [...new Map(nodes.map((n) => [n.externalId, n])).values()];
  if (!unique.length) throw new Error('syncTree: cây rỗng, không ghi để khỏi đánh removed cả sàn');
  return inTransaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`channel.category_tree:${platform}`}))`);
    const onPlatform = eq(platformCategories.platform, platform);
    const [last] = await tx.select({ at: max(platformCategories.syncedAt) }).from(platformCategories).where(onPlatform);
    if (last?.at && new Date(last.at).getTime() > syncedAt.getTime()) {
      return { upserted: 0, removed: 0, specsRemoved: 0, specsRestored: 0, skipped: true };
    }
    const ids = unique.map((n) => n.externalId);
    const synced = and(onPlatform, eq(platformCategories.status, 'active'), isNotNull(platformCategories.syncedAt));
    const [counts] = await tx
      .select({
        active: sql<number>`count(*)::int`,
        removing: sql<number>`(count(*) filter (where ${notInArray(platformCategories.externalId, ids)}))::int`,
      })
      .from(platformCategories)
      .where(synced);
    const { active = 0, removing = 0 } = counts ?? {};
    if (!opts.allowShrink && treeShrinkBlocked(active, removing)) throw new CategoryTreeShrunkError(platform, active, removing);

    for (let i = 0; i < unique.length; i += BATCH) {
      await tx
        .insert(platformCategories)
        .values(
          unique.slice(i, i + BATCH).map((n) => ({
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
          onPlatform,
          eq(platformCategories.status, 'active'),
          or(isNull(platformCategories.syncedAt), sql`${platformCategories.syncedAt} < ${syncedAt}`),
        ),
      )
      .returning({ externalId: platformCategories.externalId });
    let specsRemoved = 0;
    const gone = removed.map((r) => r.externalId);
    for (let i = 0; i < gone.length; i += BATCH) {
      const changed = await tx
        .update(productSpecs)
        .set({ categoryStatus: 'removed', updatedAt: syncedAt })
        .where(
          and(
            eq(productSpecs.platform, platform),
            inArray(productSpecs.externalCategoryId, gone.slice(i, i + BATCH)),
            sql`${productSpecs.categoryStatus} <> 'removed'`,
          ),
        )
        .returning({ id: productSpecs.id });
      specsRemoved += changed.length;
    }
    const restored = await tx
      .update(productSpecs)
      .set({ categoryStatus: 'ok', updatedAt: syncedAt })
      .where(
        and(
          eq(productSpecs.platform, platform),
          eq(productSpecs.categoryStatus, 'removed'),
          inArray(
            productSpecs.externalCategoryId,
            tx
              .select({ id: platformCategories.externalId })
              .from(platformCategories)
              .where(and(onPlatform, eq(platformCategories.status, 'active'))),
          ),
        ),
      )
      .returning({ id: productSpecs.id });
    return { upserted: unique.length, removed: gone.length, specsRemoved, specsRestored: restored.length, skipped: false };
  });
}

/** Danh sách `products` của chi tiết leaf chặn 200 dòng (plan §8, L019; ghi ở OpenAPI). */
export const SPEC_PRODUCTS_LIMIT = 200;

/** Spec của công ty (RLS, gọi trong `withCompany`) trỏ tới một leaf, cũ trước, tối đa `SPEC_PRODUCTS_LIMIT`. */
export async function specsOnCategory(platform: Marketplace, externalId: string): Promise<{ productId: string; source: SpecSource }[]> {
  return getDb()
    .select({ productId: productSpecs.productId, source: productSpecs.source })
    .from(productSpecs)
    .where(and(eq(productSpecs.platform, platform), eq(productSpecs.externalCategoryId, externalId)))
    .orderBy(asc(productSpecs.createdAt), asc(productSpecs.id))
    .limit(SPEC_PRODUCTS_LIMIT);
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
