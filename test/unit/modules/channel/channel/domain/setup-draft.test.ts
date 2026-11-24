import { describe, expect, it } from 'vitest';
import {
  applyPatch,
  changedOf,
  clearFrom,
  confirmStep,
  DRAFT_STEPS,
  draftOf,
  emptyDraft,
  missingSteps,
  pruneCreateGroups,
  reconcileWithRemote,
  type SetupDraft,
} from '#src/modules/channel/channel/domain/setup-draft.ts';
import { SetupDraftBody } from '#src/modules/channel/channel/api/schemas.ts';

const productOf = new Map([
  ['s1', 'pA'],
  ['s2', 'pA'],
  ['s3', 'pB'],
]);
const AT = '2026-11-24T10:00:00.000Z';
const confirmedAll: SetupDraft = {
  ...emptyDraft(),
  decisions: [
    { externalSkuId: 's1', action: 'link', variantId: 'v1' },
    { externalSkuId: 's3', action: 'create', variantId: null },
  ],
  createGroups: [{ externalProductId: 'pB', groupId: 'g1' }],
  openingStock: 'stocktake',
  returnWindowDays: 7,
  baseline: ['s1', 's2', 's3'],
  confirmed: { link_skus: AT, assign_groups: AT, stock_sync: AT },
};

describe('mốc xác nhận và bước (Documents/21 §18.7.5)', () => {
  it('ba bước theo thứ tự làm; enum Zod của PUT /setup/draft khớp DRAFT_STEPS', () => {
    expect(DRAFT_STEPS).toEqual(['link_skus', 'assign_groups', 'stock_sync']);
    for (const step of DRAFT_STEPS) expect(SetupDraftBody.safeParse({ confirm: step, draftVersion: 0 }).success).toBe(true);
    expect(SetupDraftBody.safeParse({ confirm: 'khac', draftVersion: 0 }).success).toBe(false);
    expect(missingSteps(emptyDraft())).toEqual([...DRAFT_STEPS]);
    expect(missingSteps(confirmedAll)).toEqual([]);
  });

  it('clearFrom xoá từ bước đó trở đi; chỉ xoá link_skus thì xoá cả baseline', () => {
    expect(clearFrom(confirmedAll, 'assign_groups').confirmed).toEqual({ link_skus: AT, assign_groups: null, stock_sync: null });
    expect(clearFrom(confirmedAll, 'assign_groups').baseline).toEqual(['s1', 's2', 's3']);
    expect(clearFrom(confirmedAll, 'stock_sync').confirmed).toEqual({ link_skus: AT, assign_groups: AT, stock_sync: null });
    const all = clearFrom(confirmedAll, 'link_skus');
    expect(all.confirmed).toEqual({ link_skus: null, assign_groups: null, stock_sync: null });
    expect(all.baseline).toBeNull();
  });

  it('confirmStep: link_skus ghi baseline; không có dòng create thì đặt luôn assign_groups', () => {
    const noCreate = { ...emptyDraft(), decisions: [{ externalSkuId: 's1', action: 'skip' as const, variantId: null }] };
    const done = confirmStep(noCreate, 'link_skus', AT, ['s2', 's1']);
    expect(done.baseline).toEqual(['s1', 's2']);
    expect(done.confirmed).toEqual({ link_skus: AT, assign_groups: AT, stock_sync: null });
    const withCreate = confirmStep(confirmedAll, 'link_skus', AT, ['s1']);
    expect(withCreate.confirmed.assign_groups).toBe(AT);
    const onlyLink = { ...confirmedAll, confirmed: { link_skus: null, assign_groups: null, stock_sync: null } };
    expect(confirmStep(onlyLink, 'link_skus', AT, ['s1']).confirmed.assign_groups).toBeNull();
  });
});

describe('applyPatch: đổi dữ liệu thì xoá mốc của bước đó và các bước sau', () => {
  it('đã xác nhận cả ba bước, đổi một dòng sang create: cả ba mốc về null', () => {
    const next = applyPatch(confirmedAll, { decisions: [{ externalSkuId: 's1', action: 'create', variantId: null }] }, productOf);
    expect(next.confirmed).toEqual({ link_skus: null, assign_groups: null, stock_sync: null });
    expect(next.baseline).toBeNull();
  });

  it('chỉ đổi danh mục ở bước 4: link_skus giữ, assign_groups và stock_sync về null', () => {
    const next = applyPatch(confirmedAll, { createGroups: [{ externalProductId: 'pB', groupId: 'g2' }] }, productOf);
    expect(next.confirmed).toEqual({ link_skus: AT, assign_groups: null, stock_sync: null });
    expect(next.baseline).toEqual(['s1', 's2', 's3']);
  });

  it('đổi openingStock hoặc returnWindowDays: chỉ stock_sync về null', () => {
    expect(applyPatch(confirmedAll, { openingStock: 'push' }, productOf).confirmed).toEqual({ link_skus: AT, assign_groups: AT, stock_sync: null });
    expect(applyPatch(confirmedAll, { returnWindowDays: 14 }, productOf).confirmed).toEqual({ link_skus: AT, assign_groups: AT, stock_sync: null });
  });

  it('ghi lại đúng giá trị cũ thì không xoá mốc nào', () => {
    const same = applyPatch(
      confirmedAll,
      {
        decisions: [{ externalSkuId: 's1', action: 'link', variantId: 'v1' }],
        createGroups: [{ externalProductId: 'pB', groupId: 'g1' }],
        openingStock: 'stocktake',
        returnWindowDays: 7,
      },
      productOf,
    );
    expect(same).toEqual(confirmedAll);
  });

  it('decisions gộp theo SKU (ghi từng trang), xếp theo externalSkuId', () => {
    const next = applyPatch(emptyDraft(), { decisions: [{ externalSkuId: 's2', action: 'skip', variantId: null }] }, productOf);
    const more = applyPatch(
      next,
      {
        decisions: [
          { externalSkuId: 's1', action: 'link', variantId: 'v1' },
          { externalSkuId: 's2', action: 'unmanaged', variantId: null },
        ],
      },
      productOf,
    );
    expect(more.decisions).toEqual([
      { externalSkuId: 's1', action: 'link', variantId: 'v1' },
      { externalSkuId: 's2', action: 'unmanaged', variantId: null },
    ]);
  });
});

describe('createGroups: bỏ phần tử của sản phẩm sàn không còn dòng create', () => {
  it('pruneCreateGroups giữ nhóm của sản phẩm còn dòng create, bỏ phần còn lại', () => {
    const draft: SetupDraft = {
      ...emptyDraft(),
      decisions: [{ externalSkuId: 's3', action: 'create', variantId: null }],
      createGroups: [
        { externalProductId: 'pA', groupId: 'g1' },
        { externalProductId: 'pB', groupId: 'g2' },
      ],
    };
    expect(pruneCreateGroups(draft, productOf).createGroups).toEqual([{ externalProductId: 'pB', groupId: 'g2' }]);
  });

  it('đổi dòng create cuối của sản phẩm sang skip thì nhóm của sản phẩm đó mất cùng lần ghi', () => {
    const next = applyPatch(confirmedAll, { decisions: [{ externalSkuId: 's3', action: 'skip', variantId: null }] }, productOf);
    expect(next.createGroups).toEqual([]);
  });

  it('nhóm gửi cho sản phẩm chưa có dòng create bị bỏ ngay', () => {
    const next = applyPatch(emptyDraft(), { createGroups: [{ externalProductId: 'pA', groupId: 'g1' }] }, productOf);
    expect(next.createGroups).toEqual([]);
  });
});

describe('SKU sàn đổi so với nháp', () => {
  it('changedOf: removed = baseline − hiện tại, added = hiện tại − baseline; null khi chưa có baseline hoặc không khác', () => {
    expect(changedOf(null, ['s1'])).toBeNull();
    expect(changedOf(['s1', 's2'], ['s2', 's1'])).toBeNull();
    expect(changedOf(['s1', 's2'], ['s2', 's9'])).toEqual({ removed: ['s1'], added: ['s9'] });
  });

  it('reconcileWithRemote: bỏ quyết định của SKU đã xoá khỏi sàn; có baseline mà tập SKU khác thì xoá mốc từ link_skus, giữ baseline', () => {
    const next = reconcileWithRemote(confirmedAll, ['s1', 's9'], new Map([['s1', 'pA'], ['s9', 'pC']]));
    expect(next.decisions).toEqual([{ externalSkuId: 's1', action: 'link', variantId: 'v1' }]);
    expect(next.createGroups).toEqual([]);
    expect(next.confirmed).toEqual({ link_skus: null, assign_groups: null, stock_sync: null });
    expect(next.baseline).toEqual(['s1', 's2', 's3']);
    expect(changedOf(next.baseline, ['s1', 's9'])).toEqual({ removed: ['s2', 's3'], added: ['s9'] });
  });

  it('chưa có baseline thì không xoá mốc nào, chỉ bỏ quyết định của SKU đã xoá', () => {
    const noBaseline: SetupDraft = { ...confirmedAll, baseline: null, confirmed: { link_skus: null, assign_groups: null, stock_sync: AT } };
    const next = reconcileWithRemote(noBaseline, ['s1'], new Map([['s1', 'pA']]));
    expect(next.confirmed.stock_sync).toBe(AT);
    expect(next.decisions).toHaveLength(1);
  });

  it('tập SKU không đổi thì nháp giữ nguyên', () => {
    expect(reconcileWithRemote(confirmedAll, ['s3', 's2', 's1'], productOf)).toEqual(confirmedAll);
  });
});

describe('draftOf: đọc nháp hỏng hình an toàn', () => {
  it('null và giá trị không phải object thì null', () => {
    expect(draftOf(null)).toBeNull();
    expect(draftOf('x')).toBeNull();
  });

  it('bỏ phần tử sai hình, trường thiếu về giá trị rỗng', () => {
    const d = draftOf({
      decisions: [{ externalSkuId: 's1', action: 'link', variantId: 'v1' }, { externalSkuId: 3 }, { externalSkuId: 's2', action: 'lạ' }],
      createGroups: [{ externalProductId: 'p', groupId: 'g' }, { externalProductId: 'p2' }],
      openingStock: 'khac',
      confirmed: { link_skus: AT },
    });
    expect(d).toEqual({
      decisions: [{ externalSkuId: 's1', action: 'link', variantId: 'v1' }],
      createGroups: [{ externalProductId: 'p', groupId: 'g' }],
      openingStock: null,
      returnWindowDays: null,
      baseline: null,
      confirmed: { link_skus: AT, assign_groups: null, stock_sync: null },
    });
  });
});
