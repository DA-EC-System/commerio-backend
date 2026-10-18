// Phiếu nhập/xuất lập tay (UC-IN-01..02; Documents/21 7.1, 7.2, K4, K10; plan #16 A5, A7, A8, A15).
import { withCompany } from '../../../shared/db/client.ts';
import { AppError } from '../../../shared/errors/app-error.ts';
import { recordAudit } from '../../audit/index.ts';
import { publishEvent } from '../../platform/index.ts';
import { type DocLineInput, docInputErrors, docNumber } from '../domain/stock.ts';
import {
  bumpDoc,
  type DocRow,
  type DocType,
  docLines,
  findDoc,
  insertManualDoc,
  listDocs,
  nextDocSeq,
  replaceDraft,
} from '../repository/documents.ts';
import { applyStockMoves } from './posting.ts';
import { invalid, namesOf, notFound, toDocSummary, toStockDoc, type Viewer, variantsById } from './views.ts';

/**
 * Luật theo loại phiếu (giá nhập, lý do xuất, dòng trùng) và biến thể, gộp một lượt 422: biến thể phải thuộc công ty;
 * phiếu nhập không nhận biến thể ngừng bán, phiếu xuất tay nhận (A7, A17).
 */
async function assertInput(type: DocType, note: string, lines: readonly DocLineInput[]): Promise<void> {
  const variants = await variantsById(lines.map((l) => l.variantId));
  const errors: Record<string, string> = {};
  lines.forEach((l, i) => {
    const v = variants.get(l.variantId);
    if (!v || (type === 'receipt' && v.archived)) errors[`lines.${i}.variantId`] = 'Biến thể không còn bán';
  });
  Object.assign(errors, docInputErrors(type, note, lines));
  if (Object.keys(errors).length > 0) throw invalid(errors);
}

async function snapshot(doc: DocRow) {
  const lines = await docLines(doc.type, doc.id);
  return {
    number: doc.number,
    status: doc.status,
    note: doc.note ?? '',
    // Chỉ giá nhập của phiếu nhập (như mock); giá vốn trên phiếu xuất không vào nhật ký vì Admin xem được nhật ký (K3).
    lines: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, ...(doc.type === 'receipt' ? { unitCost: l.unitCost } : {}) })),
  };
}

/** Ghi nhật ký thao tác trên phiếu (A15) với trạng thái sau thao tác, trả phiếu đã đọc lại. */
async function auditDoc(viewer: Viewer, action: 'create' | 'update', id: string, before?: unknown): Promise<DocRow> {
  const doc = (await findDoc(id))!;
  await recordAudit({
    companyId: viewer.companyId,
    actorId: viewer.accountId,
    action,
    entityType: doc.type === 'receipt' ? 'inventory.stock_receipts' : 'inventory.stock_issues',
    entityId: id,
    before,
    after: await snapshot(doc),
  });
  return doc;
}

/**
 * Khoá phiếu rồi kiểm theo thứ tự của mock (A8): không thấy → 404; `version` lệch → 409 `version_conflict` kèm
 * `current`; không còn nháp (hoặc không phải phiếu tay) → 409 `not_draft`.
 */
async function lockDraft(viewer: Viewer, id: string, version: number): Promise<DocRow> {
  const doc = await findDoc(id, true);
  if (!doc) throw notFound('phiếu kho');
  if (doc.version !== version) {
    throw new AppError(409, 'version_conflict', 'Phiếu vừa được người khác sửa hoặc ghi sổ', {
      current: await toStockDoc(doc, viewer),
    });
  }
  if (doc.status !== 'draft' || doc.kind !== 'manual') {
    throw new AppError(409, 'not_draft', 'Chỉ sửa, ghi sổ, huỷ được phiếu nháp lập tay');
  }
  return doc;
}

export async function listDocuments(
  viewer: Viewer,
  q: { page: number; pageSize: number; type?: DocType | undefined; status?: string | undefined; search?: string | undefined },
) {
  return withCompany(viewer.companyId, async () => {
    const { rows, total } = await listDocs({ ...q, limit: q.pageSize, offset: (q.page - 1) * q.pageSize });
    const names = await namesOf(rows.flatMap((r) => [r.createdBy, r.postedBy]));
    return { items: rows.map((r) => toDocSummary(r, names)), total, page: q.page, pageSize: q.pageSize };
  });
}

export async function getDocument(viewer: Viewer, id: string) {
  return withCompany(viewer.companyId, async () => {
    const doc = await findDoc(id);
    if (!doc) throw notFound('phiếu kho');
    return toStockDoc(doc, viewer);
  });
}

export async function createDocument(viewer: Viewer, input: { type: DocType; note: string; lines: DocLineInput[] }) {
  return withCompany(viewer.companyId, async () => {
    await assertInput(input.type, input.note, input.lines);
    const number = docNumber(input.type, await nextDocSeq(input.type));
    const id = await insertManualDoc({ ...input, number, createdBy: viewer.accountId });
    return toStockDoc(await auditDoc(viewer, 'create', id), viewer);
  });
}

export async function updateDocument(viewer: Viewer, id: string, input: { note: string; lines: DocLineInput[]; version: number }) {
  return withCompany(viewer.companyId, async () => {
    const doc = await lockDraft(viewer, id, input.version);
    await assertInput(doc.type, input.note, input.lines);
    const before = await snapshot(doc);
    await replaceDraft(doc.type, id, input.note, input.lines);
    return toStockDoc(await auditDoc(viewer, 'update', id, before), viewer);
  });
}

/** Ghi sổ (K10): một giao dịch gồm khoá phiếu, khung `applyStockMoves`, đổi trạng thái, nhật ký, sự kiện. */
export async function postDocument(viewer: Viewer, id: string, version: number) {
  return withCompany(viewer.companyId, async () => {
    const doc = await lockDraft(viewer, id, version);
    const before = await snapshot(doc);
    const lines = await docLines(doc.type, id);
    await applyStockMoves({
      direction: doc.type === 'receipt' ? 'in' : 'out',
      cost: doc.type === 'receipt' ? 'weighted' : 'current',
      doneBy: viewer.accountId,
      lines: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, lineId: l.id, unitCost: l.unitCost ?? undefined })),
    });
    const postedAt = new Date();
    await bumpDoc(doc.type, id, { status: 'done', postedBy: viewer.accountId, postedAt });
    const after = await auditDoc(viewer, 'update', id, before);
    if (doc.type === 'receipt') {
      await publishEvent({
        type: 'inventory.receipt_posted',
        aggregateId: id,
        payload: { receiptId: id, number: doc.number, kind: 'manual', lines: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })) },
      });
    } else {
      await publishEvent({
        type: 'inventory.issue_posted',
        aggregateId: id,
        payload: { issueId: id, number: doc.number, kind: 'manual', orderId: null, postedAt: postedAt.toISOString() },
      });
    }
    return toStockDoc(after, viewer);
  });
}

/** Huỷ phiếu nháp; tồn không đổi. Phiếu đã ghi sổ thì lập phiếu ngược (K10). */
export async function cancelDocument(viewer: Viewer, id: string, version: number) {
  return withCompany(viewer.companyId, async () => {
    const doc = await lockDraft(viewer, id, version);
    const before = await snapshot(doc);
    await bumpDoc(doc.type, id, { status: 'cancelled' });
    return toStockDoc(await auditDoc(viewer, 'update', id, before), viewer);
  });
}
