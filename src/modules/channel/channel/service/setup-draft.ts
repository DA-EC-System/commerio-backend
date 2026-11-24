// Ghi bản nháp thiết lập của gian hàng `connecting` (Documents/21 §18.7.5 "Bản nháp thiết lập", §18.12 `POST sku-links`):
// `PUT /setup/draft` và nhánh `connecting` của `POST sku-links` dùng chung lõi `saveDraft`. Luật thuần (xoá mốc, dọn
// `createGroups`, so `baseline`) ở `domain/setup-draft.ts`. commerio-backend#569.
import { withCompany } from '../../../../shared/db/client.ts';
import { moduleOfPermission } from '../../../../shared/auth/company-access.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import {
  applyPatch,
  confirmStep,
  type DraftPatch,
  type DraftStep,
  emptyDraft,
  type SetupDecision,
  type SetupDraft,
} from '../domain/setup-draft.ts';
import { returnWindowError } from '../domain/shop.ts';
import { listListingRows } from '../repository/listings.ts';
import { listRemoteSkuRows, type RemoteSkuRow } from '../repository/remote-skus.ts';
import { readSetupDraft, writeSetupDraftRow } from '../repository/shops.ts';
import { capabilitiesOf } from './marketplaces/index.ts';
import type { ListingVariant, ProductPort } from './product-port.ts';
import { awaitingError, CANNOT_CREATE, canManageProducts, companySetupState, createBlocker } from './setup.ts';
import { type Actor, ownShop } from './shops.ts';

export interface SkuLinksInput {
  items?:
    | {
        externalSkuId: string;
        action: 'link' | 'create' | 'skip' | 'unmanaged';
        variantId?: string | null | undefined;
      }[]
    | undefined;
  groups?: { externalProductId: string; groupId: string }[] | undefined;
  draftVersion?: number | undefined;
}

export interface DraftResult {
  externalSkuId: string;
  result: 'saved' | 'error';
  code: string | null;
  message: string | null;
}

export interface DraftWrite {
  draft: SetupDraft;
  draftVersion: number;
  results: DraftResult[];
}

/** Body của `PUT /setup/draft` (đã qua Zod). */
export interface DraftPutInput {
  openingStock?: 'push' | 'stocktake' | null | undefined;
  returnWindowDays?: number | null | undefined;
  confirm?: DraftStep | undefined;
  draftVersion: number;
}

const CONNECT = 'channel.shop.connect';
const canConnect = (actor: Actor) => actor.permissions.includes(CONNECT) && actor.enabledModules.includes(moduleOfPermission(CONNECT));

const invalid = (errors: Record<string, string>, extra: Record<string, unknown> = {}) =>
  new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', { errors, ...extra });

/** 409 `version_conflict` mang nháp hiện tại (null khi chưa có) để FE thay bản đang giữ. */
export const conflictOf = (draft: SetupDraft | null, draftVersion: number) =>
  new AppError(409, 'version_conflict', 'Bản nháp thiết lập vừa được cập nhật, tải lại', { current: { draft, draftVersion } });

/**
 * Nhóm hàng hợp lệ (danh mục chuẩn hoặc của công ty, đọc qua RLS): hỏi catalog bằng `createFromPlatform` không sản phẩm
 * nào, catalog kiểm nhóm trước và không ghi gì khi danh sách rỗng. Gọi trong `withCompany`.
 */
export async function groupValid(port: ProductPort, actor: Actor, groupId: string, shop: { id: string; shopName: string }): Promise<boolean> {
  const r = await port.createFromPlatform!({ companyId: actor.companyId, accountId: actor.accountId }, groupId, [], {
    shopId: shop.id,
    shopName: shop.shopName,
  });
  return r.ok || r.groupError === null;
}

interface Check {
  remote: ReadonlyMap<string, RemoteSkuRow>;
  variants: ReadonlyMap<string, ListingVariant>;
  listed: ReadonlySet<string>;
  reasonOf: (sellerSku: string) => keyof typeof CANNOT_CREATE | null;
}

interface RowError {
  code: string;
  message: string;
}

/** Lỗi của một quyết định so với bản sao SKU sàn và kho; `taken` là biến thể, SKU người bán đã dùng bởi quyết định khác. */
function decisionError(
  d: SetupDecision,
  c: Check,
  taken: { variants: Set<string>; createSkus: Set<string> },
): RowError | null {
  const r = c.remote.get(d.externalSkuId);
  if (!r) return { code: 'remote_sku_not_found', message: 'SKU sàn không còn trong bản sao, bấm Tải lại' };
  if (d.action === 'link') {
    const v = d.variantId ? c.variants.get(d.variantId) : undefined;
    if (!d.variantId) return { code: 'variant_required', message: 'Chọn SKU kho để liên kết' };
    if (!r.sellerSku) return { code: 'no_seller_sku', message: 'SKU sàn chưa có SKU người bán, đặt trên sàn trước rồi liên kết' };
    if (!v) return { code: 'variant_not_found', message: 'Biến thể không thuộc công ty' };
    if (v.archived) return { code: 'variant_archived', message: 'Biến thể đã lưu trữ' };
    if (c.listed.has(v.id)) return { code: 'variant_listed', message: 'Biến thể đã liên kết listing khác của gian hàng này' };
    if (taken.variants.has(v.id)) return { code: 'variant_taken', message: 'Biến thể đã chọn cho SKU sàn khác' };
    taken.variants.add(v.id);
    return null;
  }
  if (d.action === 'create') {
    const reason = c.reasonOf(r.sellerSku);
    if (reason) return { code: reason, message: CANNOT_CREATE[reason] };
    if (taken.createSkus.has(r.sellerSku)) return { code: 'duplicate_seller_sku', message: 'Hai SKU sàn cùng SKU người bán' };
    taken.createSkus.add(r.sellerSku);
  }
  return null;
}

/**
 * Nạp dữ liệu để kiểm quyết định: bản sao SKU sàn, biến thể kho, biến thể đã có listing ở gian hàng. Gọi trong
 * `withCompany`. `needVariants` false (không dòng nào cần) thì bỏ qua truy vấn kho.
 */
async function loadCheck(port: ProductPort, actor: Actor, shopId: string, rows: readonly RemoteSkuRow[], needVariants: boolean): Promise<Check> {
  const variants = needVariants ? await port.variants() : [];
  const listed = needVariants ? new Set((await listListingRows(shopId)).map((l) => l.variantId)) : new Set<string>();
  return {
    remote: new Map(rows.map((r) => [r.externalSkuId, r])),
    variants: new Map(variants.map((v) => [v.id, v])),
    listed: listed as Set<string>,
    reasonOf: createBlocker(variants, actor),
  };
}

/** Lỗi 422 theo khoá `decisions.<i>` của toàn bộ quyết định trong nháp (dùng khi xác nhận, hoàn tất). */
function allDecisionErrors(draft: SetupDraft, c: Check): Record<string, string> {
  const errors: Record<string, string> = {};
  const taken = { variants: new Set<string>(), createSkus: new Set<string>() };
  draft.decisions.forEach((d, i) => {
    const e = decisionError(d, c, taken);
    if (e) errors[`decisions.${i}`] = e.message;
  });
  return errors;
}

/** Điều kiện xác nhận từng bước (Documents/21 §18.7.5); ném 422 khi sai, không đặt mốc. */
async function assertConfirmable(
  step: DraftStep,
  draft: SetupDraft,
  ctx: { port: ProductPort; actor: Actor; shop: { id: string; shopName: string; platform: Parameters<typeof capabilitiesOf>[0] }; rows: readonly RemoteSkuRow[]; check: Check },
): Promise<void> {
  const errors: Record<string, string> = {};
  let extra: Record<string, unknown> = {};
  if (step === 'link_skus') {
    Object.assign(errors, allDecisionErrors(draft, ctx.check));
    const decided = new Set(draft.decisions.map((d) => d.externalSkuId));
    const undecided = ctx.rows.filter((r) => !decided.has(r.externalSkuId)).map((r) => r.externalSkuId);
    if (undecided.length) {
      errors.decisions = `Còn ${undecided.length} SKU sàn chưa quyết định (bỏ qua cũng là một quyết định)`;
      extra = { externalSkuIds: undecided.slice(0, 50) };
    }
  } else if (step === 'assign_groups') {
    const productOf = new Map(ctx.rows.map((r) => [r.externalSkuId, r.externalProductId]));
    const needing = [...new Set(draft.decisions.flatMap((d) => (d.action === 'create' && productOf.has(d.externalSkuId) ? [productOf.get(d.externalSkuId)!] : [])))];
    const chosen = new Set(draft.createGroups.map((g) => g.externalProductId));
    const missing = needing.filter((p) => !chosen.has(p));
    if (missing.length) {
      errors.createGroups = 'Chọn danh mục sản phẩm cho mọi sản phẩm sàn sắp tạo';
      extra = { externalProductIds: missing.slice(0, 50) };
    }
    for (const [i, g] of draft.createGroups.entries()) {
      if (!(await groupValid(ctx.port, ctx.actor, g.groupId, ctx.shop))) errors[`createGroups.${i}.groupId`] = 'Danh mục sản phẩm không hợp lệ';
    }
  } else {
    if (draft.openingStock === null) errors.openingStock = 'Chọn cách đồng bộ tồn';
    else {
      const { firstShopOfCompany, awaitingStocktake } = await companySetupState(ctx.actor, ctx.shop.id);
      if (awaitingStocktake) errors.openingStock = awaitingError(awaitingStocktake);
      else if (firstShopOfCompany && draft.openingStock === 'push') errors.openingStock = 'Gian hàng đầu tiên của công ty phải kiểm kê đầu kỳ';
    }
    const rw = returnWindowError(capabilitiesOf(ctx.shop.platform).returnWindow, draft.returnWindowDays);
    if (rw) errors.returnWindowDays = rw;
  }
  if (Object.keys(errors).length) throw invalid(errors, extra);
}

/**
 * Lõi ghi nháp. Thứ tự lỗi: 404 gian hàng → 403 thiếu quyền (`channel.shop.connect`; có dòng `create` thì thêm
 * `catalog.product.manage`) → 409 `invalid_transition` kèm `current` (không ở `connecting`, kể cả `needs_reauth`) → 409
 * `version_conflict` kèm `current: { draft, draftVersion }` → 422. Dòng `items` lỗi không ghi, dòng khác vẫn ghi (`results`);
 * `confirm` hay `groups` sai thì 422, không ghi gì (cả giao dịch rollback).
 */
async function saveDraft(
  port: ProductPort,
  actor: Actor,
  shopId: string,
  input: SkuLinksInput & Omit<DraftPutInput, 'draftVersion'> & { draftVersion: number },
): Promise<DraftWrite> {
  const items = input.items ?? [];
  return withCompany(actor.companyId, async () => {
    const shop = await ownShop(shopId);
    if (!canConnect(actor)) throw new AppError(403, 'forbidden', 'Bạn không có quyền thiết lập gian hàng');
    if (items.some((it) => it.action === 'create') && !canManageProducts(actor)) {
      throw new AppError(403, 'forbidden', CANNOT_CREATE.no_permission);
    }
    const cur = await readSetupDraft(shopId, true);
    if (!cur) throw new AppError(404, 'not_found', 'Không tìm thấy gian hàng');
    if (cur.status !== 'connecting') {
      throw new AppError(409, 'invalid_transition', 'Gian hàng không ở bước thiết lập, kết nối lại rồi thiết lập tiếp', { current: cur.status });
    }
    if (input.draftVersion !== cur.version) throw conflictOf(cur.draft, cur.version);

    const rows = await listRemoteSkuRows(shopId);
    const productOf = new Map(rows.map((r) => [r.externalSkuId, r.externalProductId]));
    const groups = input.groups ?? [];
    const groupErrors: Record<string, string> = {};
    for (const [i, g] of groups.entries()) {
      if (!productOf.size || ![...productOf.values()].includes(g.externalProductId)) groupErrors[`groups.${i}.externalProductId`] = 'Sản phẩm sàn không có trong bản sao';
      else if (!(await groupValid(port, actor, g.groupId, { id: shop.id, shopName: shop.shopName }))) groupErrors[`groups.${i}.groupId`] = 'Danh mục sản phẩm không hợp lệ';
    }
    if (Object.keys(groupErrors).length) throw invalid(groupErrors);

    const base = cur.draft ?? emptyDraft();
    const needVariants = items.some((it) => it.action === 'link' || it.action === 'create') || input.confirm === 'link_skus';
    const check = await loadCheck(port, actor, shopId, rows, needVariants);

    // Quyết định đã lưu của SKU không nằm trong lần ghi này vẫn chiếm biến thể, SKU người bán của nó.
    const inRequest = new Set(items.map((it) => it.externalSkuId));
    const taken = { variants: new Set<string>(), createSkus: new Set<string>() };
    for (const d of base.decisions) {
      if (inRequest.has(d.externalSkuId)) continue;
      if (d.action === 'link' && d.variantId) taken.variants.add(d.variantId);
      if (d.action === 'create') {
        const sku = check.remote.get(d.externalSkuId)?.sellerSku;
        if (sku) taken.createSkus.add(sku);
      }
    }
    const results: DraftResult[] = [];
    const accepted: SetupDecision[] = [];
    for (const it of items) {
      const decision: SetupDecision = { externalSkuId: it.externalSkuId, action: it.action, variantId: it.action === 'link' ? (it.variantId ?? null) : null };
      const error = decisionError(decision, check, taken);
      if (error) results.push({ externalSkuId: it.externalSkuId, result: 'error', code: error.code, message: error.message });
      else {
        accepted.push(decision);
        results.push({ externalSkuId: it.externalSkuId, result: 'saved', code: null, message: null });
      }
    }

    const patch: DraftPatch = {
      ...(items.length ? { decisions: accepted } : {}),
      ...(groups.length ? { createGroups: groups } : {}),
      ...(input.openingStock !== undefined ? { openingStock: input.openingStock } : {}),
      ...(input.returnWindowDays !== undefined ? { returnWindowDays: input.returnWindowDays } : {}),
    };
    let next = applyPatch(base, patch, productOf);
    if (input.confirm) {
      await assertConfirmable(input.confirm, next, { port, actor, shop: { id: shop.id, shopName: shop.shopName, platform: shop.platform }, rows, check });
      next = confirmStep(next, input.confirm, new Date().toISOString(), rows.map((r) => r.externalSkuId));
    }
    if (cur.draft && JSON.stringify(next) === JSON.stringify(cur.draft)) return { draft: next, draftVersion: cur.version, results };
    const version = await writeSetupDraftRow(shopId, cur.version, next);
    if (version === undefined) throw conflictOf(cur.draft, cur.version);
    return { draft: next, draftVersion: version, results };
  });
}

/** `PUT /channel/shops/:id/setup/draft`: ghi `openingStock`, `returnWindowDays` và/hoặc xác nhận một bước. */
export async function putSetupDraft(port: ProductPort, actor: Actor, shopId: string, input: DraftPutInput) {
  const { draft, draftVersion } = await saveDraft(port, actor, shopId, input);
  return { draft, draftVersion };
}

/** `POST sku-links` của gian hàng `connecting`: ghi `decisions`, `createGroups` vào nháp. `draftVersion` bắt buộc. */
export async function writeSetupDraft(port: ProductPort, actor: Actor, shopId: string, input: SkuLinksInput): Promise<DraftWrite> {
  if (input.draftVersion === undefined) throw invalid({ draftVersion: 'Thiếu phiên bản bản nháp (draftVersion)' });
  return saveDraft(port, actor, shopId, { ...input, draftVersion: input.draftVersion });
}
