// Bản nháp thiết lập gian hàng (#569, Documents/21 mục 18.7.5): dữ liệu người dùng nhập ở các bước Liên kết SKU sàn,
// Danh mục sản phẩm, Đồng bộ tồn của wizard, lưu ở `channel.shops.setup_draft`. File này giữ hình dạng, cách đọc an toàn và
// các luật thuần (xoá mốc xác nhận khi đổi dữ liệu, dọn `createGroups`, so `baseline`); service ghi nháp ở
// `service/setup-draft.ts`.

/** Ba bước có mốc xác nhận, theo thứ tự làm. */
export const DRAFT_STEPS = ['link_skus', 'assign_groups', 'stock_sync'] as const;
export type DraftStep = (typeof DRAFT_STEPS)[number];
export type DraftConfirmed = Record<DraftStep, string | null>;

export interface SetupDecision {
  externalSkuId: string;
  action: 'link' | 'create' | 'skip' | 'unmanaged';
  variantId: string | null;
}

export interface SetupDraft {
  decisions: SetupDecision[];
  createGroups: { externalProductId: string; groupId: string }[];
  openingStock: 'push' | 'stocktake' | null;
  returnWindowDays: number | null;
  /** Tập `externalSkuId` của bản sao SKU sàn lúc xác nhận `link_skus`; xoá cùng mốc */
  baseline: string[] | null;
  confirmed: DraftConfirmed;
}

export const NO_CONFIRMATION: DraftConfirmed = { link_skus: null, assign_groups: null, stock_sync: null };

/** Mốc xác nhận của nháp đã lưu; nháp chưa có hoặc hỏng hình thì coi như chưa xác nhận bước nào. */
export function draftConfirmedOf(raw: unknown): DraftConfirmed {
  const confirmed = (raw as { confirmed?: unknown } | null)?.confirmed;
  if (!confirmed || typeof confirmed !== 'object') return { ...NO_CONFIRMATION };
  const at = (v: unknown) => (typeof v === 'string' ? v : null);
  const c = confirmed as Record<string, unknown>;
  return { link_skus: at(c.link_skus), assign_groups: at(c.assign_groups), stock_sync: at(c.stock_sync) };
}

export const emptyDraft = (): SetupDraft => ({
  decisions: [],
  createGroups: [],
  openingStock: null,
  returnWindowDays: null,
  baseline: null,
  confirmed: { ...NO_CONFIRMATION },
});

const ACTIONS = ['link', 'create', 'skip', 'unmanaged'] as const;

/** Nháp đã lưu đọc an toàn: chưa có hoặc không phải object thì null; trường hỏng hình thì về giá trị rỗng. */
export function draftOf(raw: unknown): SetupDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    decisions: list(r.decisions).flatMap((d): SetupDecision[] => {
      const x = d as Partial<SetupDecision> | null;
      return x && typeof x.externalSkuId === 'string' && ACTIONS.includes(x.action as (typeof ACTIONS)[number])
        ? [{ externalSkuId: x.externalSkuId, action: x.action!, variantId: typeof x.variantId === 'string' ? x.variantId : null }]
        : [];
    }),
    createGroups: list(r.createGroups).flatMap((g) => {
      const x = g as { externalProductId?: unknown; groupId?: unknown } | null;
      return x && typeof x.externalProductId === 'string' && typeof x.groupId === 'string'
        ? [{ externalProductId: x.externalProductId, groupId: x.groupId }]
        : [];
    }),
    openingStock: r.openingStock === 'push' || r.openingStock === 'stocktake' ? r.openingStock : null,
    returnWindowDays: typeof r.returnWindowDays === 'number' ? r.returnWindowDays : null,
    baseline: Array.isArray(r.baseline) ? r.baseline.filter((x): x is string => typeof x === 'string') : null,
    confirmed: draftConfirmedOf(raw),
  };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const byKey = <T>(list: readonly T[], key: (t: T) => string) => [...list].sort((a, b) => key(a).localeCompare(key(b)));

/** Xoá mốc từ `step` trở đi; xoá mốc `link_skus` thì xoá luôn `baseline` (đặt và xoá cùng mốc). */
export function clearFrom(draft: SetupDraft, step: DraftStep): SetupDraft {
  const from = DRAFT_STEPS.indexOf(step);
  const confirmed = { ...draft.confirmed };
  DRAFT_STEPS.forEach((s, i) => {
    if (i >= from) confirmed[s] = null;
  });
  return { ...draft, confirmed, baseline: from === 0 ? null : draft.baseline };
}

/** Bỏ phần tử `createGroups` của sản phẩm sàn không còn dòng `create` nào. `productOf`: SKU sàn → sản phẩm sàn. */
export function pruneCreateGroups(draft: SetupDraft, productOf: ReadonlyMap<string, string>): SetupDraft {
  const withCreate = new Set(
    draft.decisions.flatMap((d) => (d.action === 'create' && productOf.has(d.externalSkuId) ? [productOf.get(d.externalSkuId)!] : [])),
  );
  return { ...draft, createGroups: draft.createGroups.filter((g) => withCreate.has(g.externalProductId)) };
}

export interface DraftPatch {
  /** Gộp theo `externalSkuId` (ghi từng trang): dòng mới thay dòng cũ của cùng SKU. */
  decisions?: readonly SetupDecision[] | undefined;
  /** Gộp theo `externalProductId`. */
  createGroups?: readonly { externalProductId: string; groupId: string }[] | undefined;
  openingStock?: 'push' | 'stocktake' | null | undefined;
  returnWindowDays?: number | null | undefined;
}

/**
 * Áp một lần ghi vào nháp (Documents/21 §18.7.5): gộp dữ liệu, bỏ `createGroups` hết dòng `create`, và nếu dữ liệu của một bước
 * đổi thật (`decisions` cho `link_skus`, `createGroups` cho `assign_groups`, `openingStock` và `returnWindowDays` cho
 * `stock_sync`) thì xoá mốc của bước đó và các bước sau. Ghi lại đúng giá trị cũ thì không xoá gì.
 */
export function applyPatch(base: SetupDraft, patch: DraftPatch, productOf: ReadonlyMap<string, string>): SetupDraft {
  let earliest = Infinity;
  const touch = (step: DraftStep) => {
    earliest = Math.min(earliest, DRAFT_STEPS.indexOf(step));
  };
  let next: SetupDraft = { ...base, confirmed: { ...base.confirmed } };

  if (patch.decisions) {
    const merged = new Map(base.decisions.map((d) => [d.externalSkuId, d]));
    for (const d of patch.decisions) merged.set(d.externalSkuId, d);
    next.decisions = byKey([...merged.values()], (d) => d.externalSkuId);
    if (!sameJson(byKey(base.decisions, (d) => d.externalSkuId), next.decisions)) touch('link_skus');
  }
  if (patch.createGroups) {
    const merged = new Map(base.createGroups.map((g) => [g.externalProductId, g]));
    for (const g of patch.createGroups) merged.set(g.externalProductId, g);
    next.createGroups = byKey([...merged.values()], (g) => g.externalProductId);
  }
  next = pruneCreateGroups(next, productOf);
  if (!sameJson(byKey(base.createGroups, (g) => g.externalProductId), next.createGroups)) touch('assign_groups');

  if (patch.openingStock !== undefined && patch.openingStock !== base.openingStock) {
    next.openingStock = patch.openingStock;
    touch('stock_sync');
  }
  if (patch.returnWindowDays !== undefined && patch.returnWindowDays !== base.returnWindowDays) {
    next.returnWindowDays = patch.returnWindowDays;
    touch('stock_sync');
  }
  return earliest === Infinity ? next : clearFrom(next, DRAFT_STEPS[earliest]!);
}

/**
 * Đặt mốc xác nhận `step` lúc `at`. `link_skus` ghi `baseline` (tập SKU sàn lúc đó); không có dòng `create` nào thì đặt luôn
 * mốc `assign_groups` (bước đó không có gì để làm).
 */
export function confirmStep(draft: SetupDraft, step: DraftStep, at: string, remoteSkuIds: readonly string[]): SetupDraft {
  const confirmed = { ...draft.confirmed, [step]: at };
  if (step === 'link_skus') {
    if (!draft.decisions.some((d) => d.action === 'create')) confirmed.assign_groups = at;
    return { ...draft, confirmed, baseline: [...remoteSkuIds].sort() };
  }
  return { ...draft, confirmed };
}

/** Bước chưa xác nhận, theo thứ tự làm. */
export const missingSteps = (draft: SetupDraft): DraftStep[] => DRAFT_STEPS.filter((s) => draft.confirmed[s] === null);

/** SKU sàn đổi so với lúc xác nhận `link_skus`; null khi chưa có `baseline` hoặc không khác. */
export function changedOf(baseline: readonly string[] | null, current: readonly string[]): { removed: string[]; added: string[] } | null {
  if (!baseline) return null;
  const now = new Set(current);
  const before = new Set(baseline);
  const removed = baseline.filter((id) => !now.has(id)).sort();
  const added = current.filter((id) => !before.has(id)).sort();
  return removed.length || added.length ? { removed, added } : null;
}

/**
 * Bản sao SKU sàn vừa đổi (Documents/21 §18.7.5 "SKU sàn đổi so với nháp"): bỏ `decisions` của SKU không còn trên sàn, dọn
 * `createGroups`; đã có `baseline` mà tập SKU khác thì xoá mốc từ `link_skus`. Chưa có `baseline` thì không xoá mốc nào.
 * `baseline` **giữ lại** khi xoá mốc ở đây: `draft.changed` của `GET /setup` (so `baseline` với bản sao hiện tại) cần nó để FE
 * báo "Sàn có n SKU mới, m SKU đã xoá"; xác nhận lại `link_skus` mới ghi `baseline` mới. (Hợp đồng ghi "xoá cùng mốc" nhưng
 * `changed` thì không bao giờ có giá trị nếu xoá ngay; xem ghi chú trong PR.)
 */
export function reconcileWithRemote(draft: SetupDraft, remoteSkuIds: readonly string[], productOf: ReadonlyMap<string, string>): SetupDraft {
  const present = new Set(remoteSkuIds);
  let next = pruneCreateGroups({ ...draft, decisions: draft.decisions.filter((d) => present.has(d.externalSkuId)) }, productOf);
  if (changedOf(draft.baseline, remoteSkuIds)) next = { ...clearFrom(next, 'link_skus'), baseline: draft.baseline };
  return next;
||||||| 3324eddb

export type DraftDecisionAction = SetupDecision['action'];
const DECISION_ACTIONS: readonly string[] = ['link', 'create', 'skip', 'unmanaged'];

/**
 * Lựa chọn từng SKU sàn và danh mục của sản phẩm sàn trong nháp (§18.12 `decision`, `totals`); nháp chưa có hoặc dòng hỏng
 * hình thì bỏ dòng đó (đọc an toàn như `draftConfirmedOf`).
 */
export function draftDecisionsOf(raw: unknown): { decisions: Map<string, SetupDecision>; groups: Map<string, string> } {
  const d = raw as { decisions?: unknown; createGroups?: unknown } | null;
  const decisions = new Map<string, SetupDecision>();
  for (const x of Array.isArray(d?.decisions) ? (d.decisions as Record<string, unknown>[]) : []) {
    if (typeof x?.externalSkuId !== 'string' || typeof x.action !== 'string' || !DECISION_ACTIONS.includes(x.action)) continue;
    const variantId = typeof x.variantId === 'string' ? x.variantId : null;
    decisions.set(x.externalSkuId, { externalSkuId: x.externalSkuId, action: x.action as DraftDecisionAction, variantId });
  }
  const groups = new Map<string, string>();
  for (const g of Array.isArray(d?.createGroups) ? (d.createGroups as Record<string, unknown>[]) : []) {
    if (typeof g?.externalProductId === 'string' && typeof g.groupId === 'string') groups.set(g.externalProductId, g.groupId);
  }
  return { decisions, groups };
}
