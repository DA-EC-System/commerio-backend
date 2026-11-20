/**
 * Hai nguồn gợi ý category ngoài gợi ý của sàn (#448, Documents/21 §18.5, §18.8.5). Không I/O.
 * `group`: category trong spec của các sản phẩm cùng nhóm hàng (không đếm sản phẩm đang đẩy), nhiều sản phẩm nhất lên đầu.
 * `recent`: category công ty dùng gần đây, bỏ category đã ở `items`, `group`.
 */

export interface SpecCategoryUse {
  productId: string;
  externalCategoryId: string;
  updatedAt: Date;
}

export interface CategoryUse {
  externalId: string;
  productCount: number;
  lastUsedAt: Date;
}

export const SOURCE_LIMIT = 5;

function usesOf(specs: readonly SpecCategoryUse[]): CategoryUse[] {
  const byCategory = new Map<string, { products: Set<string>; last: Date }>();
  for (const s of specs) {
    const hit = byCategory.get(s.externalCategoryId) ?? { products: new Set<string>(), last: s.updatedAt };
    hit.products.add(s.productId);
    if (s.updatedAt > hit.last) hit.last = s.updatedAt;
    byCategory.set(s.externalCategoryId, hit);
  }
  return [...byCategory].map(([externalId, v]) => ({ externalId, productCount: v.products.size, lastUsedAt: v.last }));
}

export interface PickSourcesInput {
  /** Mọi spec của công ty trên sàn. */
  specs: readonly SpecCategoryUse[];
  /** Sản phẩm đang đẩy: không đếm vào `group`. */
  productId: string;
  /** Sản phẩm cùng nhóm hàng (kể cả sản phẩm đang đẩy, bị loại ở đây). */
  sameGroupProductIds: ReadonlySet<string>;
  /** Category của gợi ý sàn. */
  itemIds: ReadonlySet<string>;
  /** Category sàn đã bỏ (`status = 'removed'`). */
  removedIds: ReadonlySet<string>;
}

export function pickSources(input: PickSourcesInput): { group: CategoryUse[]; recent: CategoryUse[] } {
  const usable = (u: CategoryUse) => !input.removedIds.has(u.externalId) && !input.itemIds.has(u.externalId);
  const group = usesOf(input.specs.filter((s) => s.productId !== input.productId && input.sameGroupProductIds.has(s.productId)))
    .filter(usable)
    .sort((a, b) => b.productCount - a.productCount || b.lastUsedAt.getTime() - a.lastUsedAt.getTime() || a.externalId.localeCompare(b.externalId))
    .slice(0, SOURCE_LIMIT);
  const inGroup = new Set(group.map((g) => g.externalId));
  const recent = usesOf(input.specs)
    .filter((u) => usable(u) && !inGroup.has(u.externalId))
    .sort((a, b) => b.lastUsedAt.getTime() - a.lastUsedAt.getTime() || b.productCount - a.productCount || a.externalId.localeCompare(b.externalId))
    .slice(0, SOURCE_LIMIT);
  return { group, recent };
}
