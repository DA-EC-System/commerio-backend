// Nguồn gợi ý category `group`, `recent` (#448 L7): xếp, loại trùng, loại removed, không đếm sản phẩm đang đẩy.
import { describe, expect, it } from 'vitest';
import { pickSources, type SpecCategoryUse } from '#src/modules/channel/channel/domain/category-sources.ts';

const at = (n: number) => new Date(Date.UTC(2026, 10, n));
const spec = (productId: string, externalCategoryId: string, day: number): SpecCategoryUse => ({ productId, externalCategoryId, updatedAt: at(day) });
const none = new Set<string>();

describe('pickSources', () => {
  it('3 sản phẩm cùng nhóm ở A, 1 ở B: group = [A (3), B (1)]; sản phẩm nhóm khác không vào group; sản phẩm đang đẩy không được đếm', () => {
    const specs = [spec('p1', 'A', 1), spec('p2', 'A', 2), spec('p3', 'A', 3), spec('p4', 'B', 4), spec('other', 'C', 5), spec('self', 'A', 6)];
    const r = pickSources({ specs, productId: 'self', sameGroupProductIds: new Set(['p1', 'p2', 'p3', 'p4', 'self']), itemIds: none, removedIds: none });
    expect(r.group.map((g) => [g.externalId, g.productCount])).toEqual([['A', 3], ['B', 1]]);
    // recent: mọi spec của công ty, bỏ A, B đã ở group; C còn lại.
    expect(r.recent.map((g) => g.externalId)).toEqual(['C']);
  });

  it('bằng productCount thì spec sửa gần nhất trước', () => {
    const specs = [spec('p1', 'X', 1), spec('p2', 'Y', 9)];
    const r = pickSources({ specs, productId: 'self', sameGroupProductIds: new Set(['p1', 'p2']), itemIds: none, removedIds: none });
    expect(r.group.map((g) => g.externalId)).toEqual(['Y', 'X']);
  });

  it('bỏ category removed và category đã có trong items ở cả hai nguồn', () => {
    const specs = [spec('p1', 'A', 1), spec('p2', 'R', 2), spec('p3', 'I', 3)];
    const r = pickSources({ specs, productId: 'self', sameGroupProductIds: new Set(['p1', 'p2', 'p3']), itemIds: new Set(['I']), removedIds: new Set(['R']) });
    expect(r.group.map((g) => g.externalId)).toEqual(['A']);
    expect(r.recent).toEqual([]);
  });

  it('tối đa 5 mỗi nguồn; recent xếp theo lần dùng gần nhất', () => {
    const specs = Array.from({ length: 8 }, (_, i) => spec(`p${i}`, `C${i}`, i + 1));
    const r = pickSources({ specs, productId: 'self', sameGroupProductIds: new Set(), itemIds: none, removedIds: none });
    expect(r.group).toEqual([]);
    expect(r.recent.map((g) => g.externalId)).toEqual(['C7', 'C6', 'C5', 'C4', 'C3']);
  });

  it('một category nhiều sản phẩm: productCount đếm sản phẩm khác nhau, lastUsedAt là lần sửa gần nhất', () => {
    const specs = [spec('p1', 'A', 1), spec('p2', 'A', 5)];
    const r = pickSources({ specs, productId: 'self', sameGroupProductIds: new Set(), itemIds: none, removedIds: none });
    expect(r.recent).toEqual([{ externalId: 'A', productCount: 2, lastUsedAt: at(5) }]);
  });
});
