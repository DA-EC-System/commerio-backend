// Lập, sửa đề nghị nhập; thêm dòng từ gợi ý nhập lại; CEO loại dòng (Documents/21 mục 16.2, Documents/25 §3).
import { recordAudit, recordTransition } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import { getVariants, validateNewProducts } from '../../catalog/index.ts';
import { nextDocNumber, stockOf } from '../../inventory/index.ts';
import { docNumber, MAX_QTY, purchasable } from '../domain/request.ts';
import {
  deleteLines,
  findLines,
  findRequest,
  insertLines,
  insertRequest,
  listRequests,
  lockRequest,
  type RequestFilter,
  type NewLine,
  type RequestRow,
  updateLine,
  updateRequest,
} from '../repository/requests.ts';
import { findSupplier } from '../repository/suppliers.ts';
import { type Actor, invalid, notFound, type PurchaseRequestView, toDetail, toSummaries } from './request-views.ts';

export interface RequestLineInput {
  variantId?: string | null | undefined;
  newProduct?: { name: string; categoryId: string } | null | undefined;
  quantity: number;
  /** Số nguyên đồng. */
  unitCost: number;
}

export interface RequestInput {
  supplierId: string;
  note: string;
  lines: RequestLineInput[];
  sourceReturnId?: string | null | undefined;
}

export const ENTITY = 'purchase_requests';
const AUDIT_ENTITY = 'product.purchase_requests';

/** Đề nghị của công ty, đã khoá; không thấy (RLS, id sai) thì 404. */
export async function lockOwnRequest(id: string): Promise<RequestRow> {
  const row = isUuid(id) ? await lockRequest(id) : undefined;
  if (!row) throw notFound('đề nghị nhập');
  return row;
}

/** `version` gửi lên khác bản đang khoá: 409 kèm bản mới nhất (N7). */
export async function assertVersion(row: RequestRow, version: number, actor: Actor): Promise<void> {
  if (row.version !== version) {
    throw new AppError(409, 'version_conflict', 'Đề nghị vừa được người khác sửa hoặc xử lý', {
      current: await toDetail(row, actor),
    });
  }
}

export async function listRequestPage(actor: Actor, q: RequestFilter) {
  return withCompany(actor.companyId, async () => {
    const { rows, total } = await listRequests(q);
    return { items: await toSummaries(rows, actor), total, page: q.page, pageSize: q.pageSize };
  });
}

export async function getRequest(actor: Actor, id: string): Promise<PurchaseRequestView> {
  return withCompany(actor.companyId, async () => {
    const row = isUuid(id) ? await findRequest(id) : undefined;
    if (!row) throw notFound('đề nghị nhập');
    return toDetail(row, actor);
  });
}

async function checkSupplier(supplierId: string, errors: Record<string, string>): Promise<void> {
  const supplier = isUuid(supplierId) ? await findSupplier(supplierId) : undefined;
  if (!supplier) errors.supplierId = 'Chọn nhà cung cấp';
  else if (!supplier.active) errors.supplierId = 'Nhà cung cấp đã ngừng giao dịch';
}

/** Kiểm dòng cần đọc DB (biến thể, danh mục, tên sản phẩm mới); lỗi theo `lines.<i>.<trường>`. */
async function buildLines(input: RequestInput): Promise<NewLine[]> {
  const errors: Record<string, string> = {};
  await checkSupplier(input.supplierId, errors);
  // Đề nghị bù hàng cần phiếu trả NCC `replaced` (B4).
  if (input.sourceReturnId) errors.sourceReturnId = 'Chưa hỗ trợ lập đề nghị bù hàng từ phiếu trả NCC';

  const variantIds = input.lines.flatMap((l) => (l.variantId ? [l.variantId] : []));
  const variants = new Map((await getVariants(variantIds)).map((v) => [v.id, v]));
  const seen = new Set<string>();
  input.lines.forEach((l, i) => {
    if (!l.variantId) return;
    const v = variants.get(l.variantId);
    if (!v) errors[`lines.${i}.variantId`] = 'Chọn sản phẩm';
    else if (!purchasable(v.businessStatus)) errors[`lines.${i}.variantId`] = 'SKU đã ngừng nhập';
    else if (seen.has(v.id)) errors[`lines.${i}.variantId`] = 'Sản phẩm bị lặp';
    seen.add(l.variantId);
  });

  const newIndexes = input.lines.flatMap((l, i) => (l.newProduct ? [i] : []));
  const newErrors = await validateNewProducts(newIndexes.map((i) => input.lines[i]!.newProduct!));
  for (const [k, e] of newErrors) errors[`lines.${newIndexes[k]}.newProduct.${e.field}`] = e.message;

  if (Object.keys(errors).length) throw invalid(errors);
  return input.lines.map((l) => ({
    variantId: l.variantId ?? null,
    newProductName: l.newProduct?.name ?? null,
    newCategoryId: l.newProduct?.categoryId ?? null,
    orderedQty: l.quantity,
    unitPrice: String(l.unitCost),
  }));
}

const snapshot = (supplierId: string | null, note: string | null, lines: readonly NewLine[]) => ({
  supplierId,
  note,
  lines: lines.map((l) => ({ ...l })),
});

export async function createRequest(actor: Actor, input: RequestInput): Promise<PurchaseRequestView> {
  return withCompany(actor.companyId, async () => {
    const lines = await buildLines(input);
    const note = input.note || null;
    const id = await insertRequest({
      companyId: actor.companyId,
      number: docNumber('DN', await nextDocNumber('purchase_request')),
      supplierId: input.supplierId,
      source: 'manual',
      note,
      createdBy: actor.accountId,
    });
    await insertLines(actor.companyId, id, lines);
    await recordTransition({ entityType: ENTITY, entityId: id, from: null, to: 'draft', action: 'create', actorId: actor.accountId });
    await recordAudit({
      companyId: actor.companyId,
      actorId: actor.accountId,
      action: 'create',
      entityType: AUDIT_ENTITY,
      entityId: id,
      before: null,
      after: snapshot(input.supplierId, note, lines),
    });
    return toDetail((await findRequest(id))!, actor);
  });
}

/** Chỉ sửa nháp hoặc đề nghị bị trả về; thay toàn bộ dòng (dòng nháp chưa bị phiếu nhận nào trỏ tới). */
export async function updateRequestDraft(actor: Actor, id: string, input: RequestInput & { version: number }) {
  return withCompany(actor.companyId, async () => {
    const row = await lockOwnRequest(id);
    await assertVersion(row, input.version, actor);
    if (row.status !== 'draft' && row.status !== 'changes_requested') {
      throw new AppError(409, 'not_draft', 'Chỉ sửa được đề nghị nháp hoặc bị trả về');
    }
    const lines = await buildLines(input);
    const old = await findLines([id]);
    const note = input.note || null;
    await deleteLines(id);
    await insertLines(actor.companyId, id, lines);
    await updateRequest(id, { supplierId: input.supplierId, note });
    await recordAudit({
      companyId: actor.companyId,
      actorId: actor.accountId,
      action: 'update',
      entityType: AUDIT_ENTITY,
      entityId: id,
      before: snapshot(row.supplierId, row.note, old),
      after: snapshot(input.supplierId, note, lines),
    });
    return toDetail((await findRequest(id))!, actor);
  });
}

/**
 * Thêm một SKU từ gợi ý nhập lại (Documents/21 mục 16.2): vào đề nghị nháp có sẵn, hoặc lập nháp mới với NCC. Trùng
 * biến thể thì cộng dồn số lượng. Giá lấy theo giá vốn bình quân hiện tại, người lập sửa trước khi gửi duyệt.
 */
export async function addLine(
  actor: Actor,
  input: { requestId: string | null; supplierId: string | null; variantId: string; quantity: number },
): Promise<{ created: boolean; request: PurchaseRequestView }> {
  return withCompany(actor.companyId, async () => {
    const errors: Record<string, string> = {};
    const [variant] = await getVariants([input.variantId]);
    if (!variant) errors.variantId = 'Sản phẩm không còn bán';
    else if (!purchasable(variant.businessStatus)) errors.variantId = 'SKU đã ngừng nhập';
    let row: RequestRow | undefined;
    if (input.requestId) {
      row = isUuid(input.requestId) ? await lockRequest(input.requestId) : undefined;
      if (!row || row.status !== 'draft') errors.requestId = 'Đề nghị không còn là nháp';
    } else {
      await checkSupplier(input.supplierId ?? '', errors);
    }
    if (Object.keys(errors).length) throw invalid(errors);

    const unitPrice = (await stockOf([variant!.id])).get(variant!.id)?.avgCost ?? '0';
    const created = !row;
    const id =
      row?.id ??
      (await insertRequest({
        companyId: actor.companyId,
        number: docNumber('DN', await nextDocNumber('purchase_request')),
        supplierId: input.supplierId!,
        source: 'reorder',
        note: 'Lập từ gợi ý nhập lại',
        createdBy: actor.accountId,
      }));
    const lines = await findLines([id]);
    const existing = lines.find((l) => l.variantId === variant!.id);
    if (existing) await updateLine(existing.id, { orderedQty: Math.min(MAX_QTY, existing.orderedQty + input.quantity) });
    else {
      const line = { variantId: variant!.id, newProductName: null, newCategoryId: null, orderedQty: input.quantity, unitPrice };
      await insertLines(actor.companyId, id, [line], lines.length);
    }
    if (created) {
      await recordTransition({ entityType: ENTITY, entityId: id, from: null, to: 'draft', action: 'create', actorId: actor.accountId });
    } else {
      await updateRequest(id, {});
    }
    await recordAudit({
      companyId: actor.companyId,
      actorId: actor.accountId,
      action: created ? 'create' : 'update',
      entityType: AUDIT_ENTITY,
      entityId: id,
      before: created ? null : snapshot(row!.supplierId, row!.note, lines),
      after: snapshot(row?.supplierId ?? input.supplierId, row?.note ?? 'Lập từ gợi ý nhập lại', await findLines([id])),
    });
    return { created, request: await toDetail((await findRequest(id))!, actor) };
  });
}

/** CEO loại hoặc bỏ loại một dòng khi đề nghị chờ duyệt; phải còn ít nhất một dòng không bị loại. */
export async function excludeLine(actor: Actor, id: string, lineId: string, input: { excluded: boolean; version: number }) {
  return withCompany(actor.companyId, async () => {
    const row = await lockOwnRequest(id);
    await assertVersion(row, input.version, actor);
    if (row.status !== 'pending_approval') {
      throw new AppError(409, 'invalid_transition', 'Chỉ loại dòng khi đề nghị đang chờ duyệt', {
        current: await toDetail(row, actor),
      });
    }
    const lines = await findLines([id]);
    const target = lines.find((l) => l.id === lineId);
    if (!target) throw notFound('dòng đề nghị');
    if (input.excluded && !lines.some((l) => !l.excluded && l.id !== lineId)) {
      throw new AppError(409, 'all_lines_excluded', 'Phải còn ít nhất một dòng');
    }
    if (target.excluded !== input.excluded) {
      await updateLine(lineId, { excluded: input.excluded });
      await updateRequest(id, {});
      await recordAudit({
        companyId: actor.companyId,
        actorId: actor.accountId,
        action: 'update',
        entityType: AUDIT_ENTITY,
        entityId: id,
        before: { lineId, excluded: target.excluded },
        after: { lineId, excluded: input.excluded },
      });
    }
    return toDetail((await findRequest(id))!, actor);
  });
}
