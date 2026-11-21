// Bản soạn trước nội dung sản phẩm mới trên đề nghị nhập (Documents/21 mục 16.3 "Bản soạn trước", 19
// `purchase_product_drafts`, 29 bước 1). Một bản cho mỗi tên cha mới trong một đề nghị; BE tạo, xoá theo dòng khi lưu đề
// nghị; ghi sổ phiếu nhận tạo cha thì chép sang sản phẩm (`copyDraftToProduct`, `copyDraftToVariant`).
import { confirmUploads, publicFileUrls, recordAudit } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import {
  applyDraftVariantFacts,
  applyPurchaseDraft,
  checkPurchaseDraft,
  type DraftContent,
  type DraftFacts,
  type DraftShape,
  draftReadiness,
  factsFor,
  groupNames,
  normalizeName,
} from '../../catalog/index.ts';
import { applyReorderRule } from '../../inventory/index.ts';
import { hasPermission, toDong } from '../domain/request.ts';
import {
  deleteDrafts,
  type DraftRow,
  draftsOfRequests,
  findDraft,
  insertDrafts,
  listDrafts,
  lockDraft,
  OPEN_REQUEST_STATUSES,
  requestRefsOf,
  updateDraft,
  updateDraftIfVersion,
} from '../repository/drafts.ts';
import { findLines, type LineRow, lockRequest } from '../repository/requests.ts';
import type { DraftVariantFacts } from '../repository/schema.ts';
import type { Actor } from './request-views.ts';

// Tự dựng lỗi (không import giá trị từ request-views: request-views đọc `draftSummaries`, tránh vòng).
const notFound = (what: string) => new AppError(404, 'not_found', `Không tìm thấy ${what}`);
const invalid = (errors: Record<string, string>, code = 'validation_failed') => new AppError(422, code, 'Dữ liệu gửi lên không hợp lệ', { errors });

export const DRAFT_AUDIT_ENTITY = 'product.purchase_product_drafts';

/** Khoá bản soạn của tên cha mới: chữ thường, gộp khoảng trắng (19 `parent_key`). */
export const parentKeyOf = (name: string) => normalizeName(name).toLowerCase();

const comboKey = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([a, v]) => `${normalizeName(a).toLowerCase()}=${normalizeName(v).toLowerCase()}`)
    .sort()
    .join('|');

const toRecord = (options: readonly { axis: string; value: string }[] | null) => Object.fromEntries((options ?? []).map((o) => [o.axis, o.value]));

/**
 * Dòng thuộc bản soạn: dòng cha mới cùng tên, hoặc dòng đã chuyển sang trỏ cha vừa tạo từ bản soạn (phiếu đầu ghi sổ đổi
 * dòng anh em sang `new_parent_product_id`). Dòng bị loại không tính.
 */
function linesOf(draft: DraftRow, lines: readonly LineRow[]): LineRow[] {
  return lines.filter(
    (l) =>
      !l.excluded &&
      ((l.newParentName !== null && parentKeyOf(l.newParentName) === draft.parentKey) || (draft.productId !== null && l.newParentProductId === draft.productId)),
  );
}

function shapeOf(draft: DraftRow, lines: readonly LineRow[]): DraftShape & { lines: LineRow[] } {
  const own = linesOf(draft, lines);
  const axes: string[] = [];
  for (const l of own) for (const o of l.newOptionValues ?? []) if (!axes.some((a) => normalizeName(a).toLowerCase() === normalizeName(o.axis).toLowerCase())) axes.push(o.axis);
  return { groupId: own.find((l) => l.newGroupId)?.newGroupId ?? null, axes, combos: own.map((l) => toRecord(l.newOptionValues)), lines: own };
}

const contentOf = (d: DraftRow): DraftContent => ({
  description: d.description,
  brand: d.brand,
  originCountry: d.originCountry,
  imageFileIds: d.imageFileIds,
  sizeChartFileId: d.sizeChartFileId,
  specs: d.specs,
  imageAxis: d.imageAxis,
  optionImages: d.optionImages,
});

/** Số của tổ hợp: ghi đè theo tổ hợp, trống thì số chung. */
function factsOfDraft(d: DraftRow, combo: Record<string, string>): DraftFacts {
  const own = d.variantFacts.find((f) => comboKey(f.optionValues) === comboKey(combo));
  return factsFor(d.variantDefaults, own);
}

/** Tiền lưu chuỗi `numeric`, ra API số nguyên đồng (21 R2). */
function factsView(f: DraftVariantFacts) {
  const money = (v: string | null | undefined) => (v === null || v === undefined ? null : toDong(v));
  return {
    standardPrice: money(f.standardPrice),
    targetNetPrice: money(f.targetNetPrice),
    weightG: f.weightG ?? null,
    lengthMm: f.lengthMm ?? null,
    widthMm: f.widthMm ?? null,
    heightMm: f.heightMm ?? null,
    minQty: f.minQty ?? null,
  };
}

type Refs = Awaited<ReturnType<typeof requestRefsOf>>;

async function summaryOf(d: DraftRow, lines: readonly LineRow[], refs: Refs, groups: Map<string, string>) {
  const shape = shapeOf(d, lines);
  const parentName = shape.lines.find((l) => l.newParentName)?.newParentName ?? d.parentKey;
  const ref = refs.get(d.requestId);
  return {
    id: d.id,
    requestId: d.requestId,
    requestNumber: ref?.number ?? '',
    requestStatus: ref?.status ?? '',
    supplierName: ref?.supplierName ?? '',
    expectedDeliveryDate: ref?.expectedDeliveryDate ?? null,
    parentName,
    groupId: shape.groupId,
    groupName: shape.groupId ? (groups.get(shape.groupId) ?? '') : '',
    readiness: { missing: await draftReadiness(shape, parentName, contentOf(d), (c) => factsOfDraft(d, c)) },
    productId: d.productId,
    version: d.version,
  };
}

/** `ProductDraftSummary` (21 mục 16.3) của các bản soạn thuộc những đề nghị đã đọc dòng. */
export async function draftSummaries(drafts: readonly DraftRow[], lines: readonly LineRow[]) {
  if (!drafts.length) return [];
  const refs = await requestRefsOf([...new Set(drafts.map((d) => d.requestId))]);
  const groups = await groupNames(lines.flatMap((l) => (l.newGroupId ? [l.newGroupId] : [])));
  return Promise.all(drafts.map((d) => summaryOf(d, lines.filter((l) => l.requestId === d.requestId), refs, groups)));
}

/** `ProductDraft` đầy đủ (21 mục 16.3). */
async function toDraftView(d: DraftRow) {
  const lines = await findLines([d.requestId]);
  const [summary] = await draftSummaries([d], lines);
  const shape = shapeOf(d, lines);
  const fileIds = [...d.imageFileIds, ...(d.sizeChartFileId ? [d.sizeChartFileId] : []), ...d.optionImages.map((o) => o.fileId)];
  const urls = fileIds.length ? await publicFileUrls(fileIds) : new Map<string, string>();
  return {
    ...summary!,
    description: d.description ?? '',
    brand: d.brand,
    originCountry: d.originCountry,
    images: d.imageFileIds.map((fileId) => ({ fileId, url: urls.get(fileId) ?? '' })),
    sizeChart: d.sizeChartFileId ? { fileId: d.sizeChartFileId, url: urls.get(d.sizeChartFileId) ?? '' } : null,
    specs: d.specs,
    imageAxis: d.imageAxis,
    optionImages: d.optionImages.map((o) => ({ ...o, url: urls.get(o.fileId) ?? '' })),
    variantDefaults: factsView(d.variantDefaults),
    variants: shape.lines.map((l) => {
      const optionValues = toRecord(l.newOptionValues);
      const own = d.variantFacts.find((f) => comboKey(f.optionValues) === comboKey(optionValues));
      return { optionValues, variantId: l.variantId, ...factsView(own ?? {}) };
    }),
  };
}
export type ProductDraftView = Awaited<ReturnType<typeof toDraftView>>;

/**
 * Lưu đề nghị (`POST`, `PUT /requests`): mỗi tên cha mới có đúng một bản soạn; tên không còn dòng nào thì xoá bản soạn
 * chưa tạo sản phẩm (FE hỏi trước khi lưu); bỏ số của tổ hợp không còn dòng nào. Chạy trong giao dịch lưu đề nghị.
 */
export async function syncDrafts(companyId: string, requestId: string): Promise<void> {
  const lines = await findLines([requestId]);
  const keys = new Set(lines.flatMap((l) => (l.newParentName ? [parentKeyOf(l.newParentName)] : [])));
  const drafts = await draftsOfRequests([requestId]);
  await deleteDrafts(drafts.filter((d) => d.productId === null && !keys.has(d.parentKey)).map((d) => d.id));
  await insertDrafts(companyId, requestId, [...keys].filter((k) => !drafts.some((d) => d.parentKey === k)));
  for (const d of await draftsOfRequests([requestId])) {
    const combos = new Set(shapeOf(d, lines).combos.map(comboKey));
    const kept = d.variantFacts.filter((f) => combos.has(comboKey(f.optionValues)));
    if (kept.length !== d.variantFacts.length) await updateDraft(d.id, { variantFacts: kept });
  }
}

const canView = (actor: Actor) =>
  ['purchasing.request.manage', 'purchasing.request.approve', 'purchasing.receipt.manage', 'purchasing.return.manage', 'catalog.product.manage'].some((p) =>
    hasPermission(actor, p),
  );

export async function getDraft(actor: Actor, id: string): Promise<ProductDraftView> {
  return withCompany(actor.companyId, async () => {
    const draft = isUuid(id) ? await findDraft(id) : undefined;
    if (!draft || !canView(actor)) throw notFound('bản soạn');
    return toDraftView(draft);
  });
}

export async function listDraftPage(actor: Actor, q: { pending: boolean; page: number; pageSize: number }) {
  return withCompany(actor.companyId, async () => {
    const { items, total } = await listDrafts(q);
    const drafts = items.map((i) => i.draft);
    const lines = await findLines([...new Set(drafts.map((d) => d.requestId))]);
    return { items: await draftSummaries(drafts, lines), total, page: q.page, pageSize: q.pageSize };
  });
}

/** Đầu vào `PUT /purchasing/product-drafts/:id` sau Zod; tiền đã là chuỗi thập phân. */
export interface DraftUpdateInput {
  description?: string | null | undefined;
  brand?: string | null | undefined;
  originCountry?: string | null | undefined;
  imageFileIds?: string[] | undefined;
  sizeChartFileId?: string | null | undefined;
  specs?: DraftContent['specs'] | undefined;
  imageAxis?: string | null | undefined;
  optionImages?: { axis: string; value: string; fileId: string }[] | undefined;
  variantDefaults?: DraftVariantFacts | undefined;
  variants?: ({ optionValues: Record<string, string> } & DraftVariantFacts)[] | undefined;
  version: number;
}

const PRODUCT_KEYS = ['description', 'brand', 'originCountry', 'imageFileIds', 'sizeChartFileId', 'specs', 'imageAxis', 'optionImages', 'variantDefaults'] as const;

/**
 * Sửa bản soạn (21 mục 16.3): đề nghị chưa kết thúc (`draft` … `partially_received`), không cần duyệt lại. Cha đã tạo thì
 * phần sản phẩm 409 `draft_closed` kèm `productId`, `variants` của tổ hợp chưa có SKU vẫn sửa được; tổ hợp đã có SKU 422
 * `variant_created`. Thứ tự khoá: đề nghị → bản soạn (ghi sổ phiếu nhận khoá đề nghị trước khi chép).
 */
export async function updateDraftContent(actor: Actor, id: string, input: DraftUpdateInput): Promise<ProductDraftView> {
  const fileIds = [...(input.imageFileIds ?? []), ...(input.sizeChartFileId ? [input.sizeChartFileId] : []), ...(input.optionImages ?? []).map((o) => o.fileId)];
  await confirmUploads(actor.companyId, fileIds);
  return withCompany(actor.companyId, async () => {
    const found = isUuid(id) ? await findDraft(id) : undefined;
    if (!found) throw notFound('bản soạn');
    const request = await lockRequest(found.requestId);
    const draft = await lockDraft(id);
    if (!request || !draft) throw notFound('bản soạn');
    if (!(OPEN_REQUEST_STATUSES as readonly string[]).includes(request.status)) {
      throw new AppError(409, 'draft_closed', 'Đề nghị nhập hàng đã kết thúc, không sửa bản soạn được nữa', { productId: draft.productId });
    }
    if (draft.version !== input.version) {
      throw new AppError(409, 'version_conflict', 'Có người vừa sửa bản soạn này', { current: await toDraftView(draft) });
    }
    const touchesProduct = PRODUCT_KEYS.some((k) => input[k] !== undefined);
    if (draft.productId && touchesProduct) {
      throw new AppError(409, 'draft_closed', 'Sản phẩm đã được tạo khi nhập kho; sửa ở trang sản phẩm', { productId: draft.productId });
    }

    const lines = await findLines([draft.requestId]);
    const shape = shapeOf(draft, lines);
    const errors: Record<string, string> = {};
    let code = 'validation_failed';
    const canReorder = hasPermission(actor, 'inventory.reorder.manage');
    if (input.variantDefaults?.minQty != null && !canReorder) errors['variantDefaults.minQty'] = 'Cần quyền chỉnh ngưỡng tồn';
    for (const [i, v] of (input.variants ?? []).entries()) {
      const line = shape.lines.find((l) => comboKey(toRecord(l.newOptionValues)) === comboKey(v.optionValues));
      if (!line) errors[`variants.${i}.optionValues`] = 'Không có dòng nào trên đề nghị có biến thể này';
      else if (line.variantId) {
        errors[`variants.${i}`] = 'Biến thể đã được tạo khi nhập kho; sửa ở trang sản phẩm';
        code = 'variant_created';
      } else if (v.minQty != null && !canReorder) errors[`variants.${i}.minQty`] = 'Cần quyền chỉnh ngưỡng tồn';
    }
    Object.assign(
      errors,
      await checkPurchaseDraft(shape, {
        imageFileIds: input.imageFileIds,
        sizeChartFileId: input.sizeChartFileId ?? null,
        specs: input.specs,
        imageAxis: input.imageAxis === undefined ? draft.imageAxis : input.imageAxis,
        optionImages: input.optionImages,
      }),
    );
    if (Object.keys(errors).length) throw invalid(errors, code);

    const set: Parameters<typeof updateDraftIfVersion>[2] = { updatedBy: actor.accountId };
    if (input.description !== undefined) set.description = input.description?.trim() || null;
    if (input.brand !== undefined) set.brand = input.brand?.trim() || null;
    if (input.originCountry !== undefined) set.originCountry = input.originCountry?.trim().toUpperCase() || null;
    if (input.imageFileIds !== undefined) set.imageFileIds = input.imageFileIds;
    if (input.sizeChartFileId !== undefined) set.sizeChartFileId = input.sizeChartFileId;
    if (input.specs !== undefined) set.specs = [...input.specs];
    if (input.imageAxis !== undefined) set.imageAxis = input.imageAxis?.trim() || null;
    if (input.optionImages !== undefined) set.optionImages = input.optionImages;
    if (input.variantDefaults !== undefined) set.variantDefaults = input.variantDefaults;
    if (input.variants !== undefined) {
      // Thay số của các tổ hợp gửi lên; tổ hợp không gửi giữ nguyên.
      const sent = new Set(input.variants.map((v) => comboKey(v.optionValues)));
      set.variantFacts = [...draft.variantFacts.filter((f) => !sent.has(comboKey(f.optionValues))), ...input.variants];
    }
    if (!(await updateDraftIfVersion(id, input.version, set))) {
      throw new AppError(409, 'version_conflict', 'Có người vừa sửa bản soạn này', { current: await toDraftView((await findDraft(id))!) });
    }
    await recordAudit({
      companyId: actor.companyId,
      actorId: actor.accountId,
      action: 'update',
      entityType: DRAFT_AUDIT_ENTITY,
      entityId: id,
      label: `${request.number} · ${shape.lines.find((l) => l.newParentName)?.newParentName ?? draft.parentKey}`,
      before: null,
      after: { ...input, version: undefined },
    });
    return toDraftView((await findDraft(id))!);
  });
}

/**
 * Ghi sổ phiếu nhận vừa tạo cha mới từ tên `parentKey` (21 mục 16.3): chép phần sản phẩm của bản soạn sang cha, đặt
 * `product_id`. Không có bản soạn thì thôi. Chạy trong giao dịch ghi sổ, sau khi đề nghị đã khoá.
 */
export async function copyDraftToProduct(companyId: string, requestId: string, requestNumber: string, parentKey: string, productId: string): Promise<void> {
  const draft = (await draftsOfRequests([requestId])).find((d) => d.parentKey === parentKey && d.productId === null);
  if (!draft) return;
  await applyPurchaseDraft(companyId, productId, contentOf(draft), { draftId: draft.id, requestNumber, authorId: draft.updatedBy });
  await updateDraft(draft.id, { productId });
}

/**
 * Mỗi SKU sinh ra khi ghi sổ (phiếu đầu hoặc phiếu sau) nhận số của tổ hợp trong bản soạn; ngưỡng tồn ghi qua
 * `applyReorderRule` của inventory (giữ luật và nhật ký ngưỡng tồn). `line` là dòng đề nghị trước khi ghi sổ.
 */
export async function copyDraftToVariant(
  actor: { companyId: string; accountId: string },
  requestId: string,
  requestNumber: string,
  line: LineRow,
  productId: string,
  variantId: string,
  label: string,
): Promise<void> {
  const drafts = await draftsOfRequests([requestId]);
  const draft = drafts.find((d) => (line.newParentName ? d.parentKey === parentKeyOf(line.newParentName) : d.productId === productId));
  if (!draft) return;
  const facts = factsOfDraft(draft, toRecord(line.newOptionValues));
  const source = { draftId: draft.id, requestNumber, authorId: draft.updatedBy };
  await applyDraftVariantFacts(actor.companyId, variantId, facts, contentOf(draft), source);
  if (facts.minQty != null) {
    await applyReorderRule({ companyId: actor.companyId, accountId: draft.updatedBy ?? actor.accountId }, variantId, { minQty: facts.minQty, version: 0, label });
  }
}
