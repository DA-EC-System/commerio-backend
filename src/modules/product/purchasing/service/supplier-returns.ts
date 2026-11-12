// Phiếu trả NCC (sơ đồ B4; Documents/21 mục 16.2–16.4; #210). Nguồn: hệ thống lập nháp từ hàng lỗi của phiếu nhận (#109),
// kiểm hàng về, xuất huỷ bị từ chối (#208, qua `product/index.ts`); kho lập tay cho hàng ở chờ xử lý. Gửi duyệt → duyệt và
// gửi (chờ xử lý giảm) → NCC hoàn tiền / bù hàng / không nhận (hàng về lại chờ xử lý). Huỷ thì nhập lại tồn hoặc xuất huỷ.
import { Decimal } from 'decimal.js';
import { canSelfApprove, getStatusHistory, publishEvent, recordAudit, recordTransition } from '../../../core/index.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { currentCompanyId, withCompany } from '../../../../shared/db/client.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import { getVariants } from '../../catalog/index.ts';
import {
  createQuarantineWriteOff,
  InsufficientStock,
  moveSupplierReturn,
  nextDocNumber,
  stockDocumentRefs,
  stockDocumentsFrom,
  stockOf,
} from '../../inventory/index.ts';
import { canSeeCost, docNumber, toDong } from '../domain/request.ts';
import {
  isResultAction,
  type SupplierReturnAction,
  supplierReturnMachine,
  type SupplierReturnStatus,
} from '../domain/return-machine.ts';
import { findReceipt } from '../repository/receipts.ts';
import { findRequest } from '../repository/requests.ts';
import {
  findReturn,
  insertDraftReturn,
  insertReturnLines,
  linesOfReturns,
  listReturns,
  replaceReturnLines,
  type ReturnLineRow,
  type ReturnRow,
  updateReturn,
} from '../repository/returns.ts';
import { findSupplier } from '../repository/suppliers.ts';
import { type Actor, attributesLabel, invalid, namesOf, notFound } from './request-views.ts';
import { checkTransition } from './transitions.ts';

export const RETURN_ENTITY = 'supplier_returns';
const AUDIT_ENTITY = 'product.supplier_returns';
const MAX_REFUND = 10_000_000_000;

export interface SupplierReturnDraftInput {
  source: 'quarantine' | 'customer_return' | 'write_off_rejected';
  /** Phiếu kho sinh ra phiếu trả. */
  sourceId: string;
  lines: readonly { variantId: string; quantity: number; unitCost: string | null; sourceLineId: string | null }[];
  note: string;
}

/** Phiếu trả NCC nháp chưa chọn NCC (mua hàng chọn sau), trong giao dịch của bên gọi. */
export async function draftSupplierReturn(input: SupplierReturnDraftInput): Promise<{ id: string; number: string }> {
  const companyId = currentCompanyId()!;
  const number = docNumber('TN', await nextDocNumber('supplier_return'));
  const id = await insertDraftReturn({ companyId, number, supplierId: null, sourceId: input.sourceId, source: input.source, note: input.note });
  await insertReturnLines(companyId, id, input.lines.filter((l) => l.quantity > 0));
  await recordTransition({ entityType: RETURN_ENTITY, entityId: id, from: null, to: 'draft', action: 'create', actorId: null });
  return { id, number };
}

// ---------- Dựng dữ liệu trả về (FE `src/types/purchasing.ts` SupplierReturn) ----------

const STOCK_DOC_SOURCES = new Set(['quarantine', 'customer_return', 'write_off_rejected']);

async function sourceOf(row: ReturnRow) {
  if (!row.sourceId) return null;
  if (row.source === 'receipt_defect') {
    const receipt = await findReceipt(row.sourceId);
    return receipt ? { type: 'goods_receipt' as const, id: receipt.id, number: receipt.number } : null;
  }
  if (STOCK_DOC_SOURCES.has(row.source)) {
    const [doc] = await stockDocumentRefs([row.sourceId]);
    return doc ? { type: 'stock_document' as const, id: doc.id, number: doc.number } : null;
  }
  return null;
}

async function summaries(rows: readonly ReturnRow[]) {
  const lines = await linesOfReturns(rows.map((r) => r.id));
  const names = await namesOf(rows.map((r) => r.createdBy));
  const out = [];
  for (const r of rows) {
    const supplier = r.supplierId ? await findSupplier(r.supplierId) : undefined;
    out.push({
      id: r.id,
      number: r.number,
      status: r.status,
      supplier: supplier ? { id: supplier.id, name: supplier.name } : null,
      source: await sourceOf(r),
      note: r.note ?? '',
      totalQty: (lines.get(r.id) ?? []).reduce((s, l) => s + l.quantity, 0),
      createdBy: r.createdBy ? (names.get(r.createdBy) ?? '') : 'Hệ thống',
      createdById: r.createdBy ?? '',
      createdAt: r.createdAt.toISOString(),
      sentAt: r.sentAt?.toISOString() ?? null,
      version: r.version,
    });
  }
  return out;
}

async function detail(row: ReturnRow, actor: Actor) {
  const [summary] = await summaries([row]);
  const lines = (await linesOfReturns([row.id])).get(row.id) ?? [];
  const variants = new Map((await getVariants(lines.map((l) => l.variantId))).map((v) => [v.id, v]));
  const stock = await stockOf(lines.map((l) => l.variantId));
  const showCost = canSeeCost(actor);
  const names = await namesOf([row.sentBy]);
  const replacement = row.replacementRequestId ? await findRequest(row.replacementRequestId) : undefined;
  const writeOffs = await stockDocumentsFrom('supplier_return', [row.id]);
  return {
    ...summary!,
    lines: lines.map((l) => {
      const v = variants.get(l.variantId);
      return {
        variantId: l.variantId,
        sku: v?.sku ?? '',
        productName: v?.productName ?? '',
        attributesLabel: v ? attributesLabel(v) : '',
        quantity: l.quantity,
        quarantine: stock.get(l.variantId)?.quarantine ?? 0,
        unitCost: showCost && l.unitCost !== null ? toDong(l.unitCost) : null,
      };
    }),
    sentBy: row.sentBy ? (names.get(row.sentBy) ?? '') : null,
    sentById: row.sentBy,
    refundAmount: row.refundAmount === null ? null : toDong(row.refundAmount),
    replacementRequest: replacement ? { type: 'purchase_request' as const, id: replacement.id, number: replacement.number } : null,
    cancelDecision: row.cancelDecision,
    followUps: writeOffs.map((d) => ({ type: 'stock_document' as const, id: d.id, number: d.number })),
    statusHistory: await getStatusHistory(RETURN_ENTITY, row.id),
  };
}

async function load(id: string, lock?: 'update') {
  const row = isUuid(id) ? await findReturn(id, lock) : undefined;
  if (!row) throw notFound('phiếu trả NCC');
  return row;
}

async function conflict(row: ReturnRow, actor: Actor) {
  return new AppError(409, 'version_conflict', 'Phiếu vừa được người khác sửa hoặc xử lý', { current: await detail(row, actor) });
}

export function listSupplierReturns(
  actor: Actor,
  q: { page: number; pageSize: number; search?: string | undefined; status?: SupplierReturnStatus | undefined; supplierId?: string | undefined },
) {
  return withCompany(actor.companyId, async () => {
    const { rows, total } = await listReturns(q, { limit: q.pageSize, offset: (q.page - 1) * q.pageSize });
    return { items: await summaries(rows), total, page: q.page, pageSize: q.pageSize };
  });
}

export function getSupplierReturn(actor: Actor, id: string) {
  return withCompany(actor.companyId, async () => detail(await load(id), actor));
}

// ---------- Lập, sửa ----------

export interface SupplierReturnInput {
  supplierId: string | null;
  note: string;
  lines: { variantId: string; quantity: number }[];
}

/**
 * Kiểm NCC đang giao dịch và dòng: biến thể của công ty, không lặp, số lượng không vượt chờ xử lý hiện có (§16.2).
 * Dòng giữ giá vốn và dòng gốc cũ khi trùng biến thể (phiếu hệ thống lập từ phiếu nhận, kiểm hàng về).
 */
async function buildLines(input: SupplierReturnInput, old: readonly ReturnLineRow[]) {
  const errors: Record<string, string> = {};
  if (input.note.length > 500) errors.note = 'Ghi chú tối đa 500 ký tự';
  if (input.supplierId) {
    const supplier = isUuid(input.supplierId) ? await findSupplier(input.supplierId) : undefined;
    if (!supplier) errors.supplierId = 'Không có nhà cung cấp này';
    else if (!supplier.active) errors.supplierId = 'Nhà cung cấp đã ngừng giao dịch';
  }
  if (input.lines.length > 200) errors.lines = 'Tối đa 200 dòng một phiếu';
  const variants = new Map((await getVariants(input.lines.map((l) => l.variantId))).map((v) => [v.id, v]));
  const stock = await stockOf(input.lines.map((l) => l.variantId));
  const seen = new Set<string>();
  const avg = new Map([...stock].map(([id, s]) => [id, s.avgCost]));
  const lines = input.lines.map((l, i) => {
    if (!variants.get(l.variantId)) errors[`lines.${i}.variantId`] = 'Chọn sản phẩm';
    else if (seen.has(l.variantId)) errors[`lines.${i}.variantId`] = 'Biến thể bị lặp';
    seen.add(l.variantId);
    const has = stock.get(l.variantId)?.quarantine ?? 0;
    if (!Number.isInteger(l.quantity) || l.quantity < 1) errors[`lines.${i}.quantity`] = 'Số lượng là số nguyên từ 1';
    else if (l.quantity > has) errors[`lines.${i}.quantity`] = `Chỉ còn ${has} chờ xử lý`;
    const prev = old.find((o) => o.variantId === l.variantId);
    return { variantId: l.variantId, quantity: l.quantity, unitCost: prev?.unitCost ?? avg.get(l.variantId) ?? null, sourceLineId: prev?.sourceLineId ?? null };
  });
  if (Object.keys(errors).length) throw invalid(errors);
  return lines;
}

const snapshot = (row: Pick<ReturnRow, 'number' | 'status' | 'supplierId' | 'note'>, lines: number) => ({
  code: row.number,
  status: row.status,
  supplierId: row.supplierId,
  note: row.note,
  lines,
});

export function createSupplierReturn(actor: Actor, input: SupplierReturnInput) {
  return withCompany(actor.companyId, async () => {
    const note = input.note.trim();
    const lines = await buildLines({ ...input, note }, []);
    const number = docNumber('TN', await nextDocNumber('supplier_return'));
    const id = await insertDraftReturn({
      companyId: actor.companyId,
      number,
      supplierId: input.supplierId,
      sourceId: null,
      source: 'manual',
      note,
      createdBy: actor.accountId,
    });
    await insertReturnLines(actor.companyId, id, lines);
    await recordTransition({ entityType: RETURN_ENTITY, entityId: id, from: null, to: 'draft', action: 'create', actorId: actor.accountId });
    const row = (await findReturn(id))!;
    await recordAudit({ companyId: actor.companyId, actorId: actor.accountId, action: 'create', entityType: AUDIT_ENTITY, entityId: id, after: snapshot(row, lines.length) });
    return detail(row, actor);
  });
}

export function updateSupplierReturn(actor: Actor, id: string, input: SupplierReturnInput & { version: number }) {
  return withCompany(actor.companyId, async () => {
    const row = await load(id, 'update');
    if (row.version !== input.version) throw await conflict(row, actor);
    if (row.status !== 'draft') throw new AppError(409, 'not_draft', 'Chỉ sửa được phiếu nháp');
    const note = input.note.trim();
    const lines = await buildLines({ ...input, note }, (await linesOfReturns([row.id])).get(row.id) ?? []);
    const updated = await updateReturn(row.id, row.version, { supplierId: input.supplierId, note });
    if (!updated) throw await conflict(row, actor);
    await replaceReturnLines(actor.companyId, row.id, lines);
    await recordAudit({
      companyId: actor.companyId,
      actorId: actor.accountId,
      action: 'update',
      entityType: AUDIT_ENTITY,
      entityId: row.id,
      before: snapshot(row, 0),
      after: snapshot(updated, lines.length),
    });
    return detail(updated, actor);
  });
}

// ---------- Thao tác ----------

/**
 * Dòng cho lõi tồn. Huỷ chọn nhập lại tồn (`restock`): chỉ hàng nguồn khách trả vào tồn thực theo giá vốn trên dòng kiện;
 * nguồn khác (hàng lỗi phiếu nhận mang giá đề nghị, lập tay mang giá bình quân lúc lập) truyền `null` để giữ giá vốn
 * bình quân hiện tại (US-NH-15 dòng 1, review #279).
 */
const toReturnLines = (row: ReturnRow, kind: 'send' | 'back' | 'restock', lines: readonly ReturnLineRow[]) =>
  lines.map((l) => ({
    lineId: l.id,
    variantId: l.variantId,
    quantity: l.quantity,
    unitCost: kind === 'restock' && row.source !== 'customer_return' ? null : l.unitCost,
  }));

async function moveStock(row: ReturnRow, kind: 'send' | 'back' | 'restock', lines: readonly ReturnLineRow[], actorId: string) {
  try {
    await moveSupplierReturn(row.id, kind, toReturnLines(row, kind, lines), actorId);
  } catch (err) {
    if (!(err instanceof InsufficientStock)) throw err;
    const errors: Record<string, string> = {};
    lines.forEach((l, i) => {
      if (err.variantIds.includes(l.variantId)) errors[`lines.${i}.quantity`] = 'Chờ xử lý không còn đủ hàng';
    });
    throw invalid(errors, 'stock_insufficient');
  }
}

export interface SupplierReturnActionInput {
  version: number;
  reason?: string | null | undefined;
  refundAmount?: number | undefined;
  cancelDecision?: 'restock' | 'write_off' | undefined;
}

export function actOnSupplierReturn(actor: Actor, id: string, action: SupplierReturnAction, input: SupplierReturnActionInput) {
  return withCompany(actor.companyId, async () => {
    const row = await load(id, 'update');
    if (row.version !== input.version) throw await conflict(row, actor);
    const lines = (await linesOfReturns([row.id])).get(row.id) ?? [];
    const reason = input.reason?.trim() || null;
    // Ghi kết quả: người thứ hai so với người gửi; bước khác so với người lập.
    const against = isResultAction(action) ? row.sentBy : row.createdBy;
    const canSelf = against === actor.accountId && (await canSelfApprove(actor.accountId));
    const record = { createdBy: against, lineCount: lines.length, hasSupplier: row.supplierId !== null };
    const { to, selfApproved } = await checkTransition(
      supplierReturnMachine,
      row.status,
      action,
      { actor, record, reason, canSelfApprove: canSelf },
      () => detail(row, actor),
    );
    const now = new Date();
    const set: Parameters<typeof updateReturn>[2] = { status: to };

    switch (action) {
      case 'submit':
        // Phiếu hệ thống lập (người lập trống): người gửi duyệt thành người lập, người duyệt và gửi phải khác.
        if (!row.createdBy) set.createdBy = actor.accountId;
        break;
      case 'send_back':
        set.statusReason = reason;
        break;
      case 'approve_send':
        if (!(await findSupplier(row.supplierId!))?.active) {
          throw new AppError(422, 'supplier_inactive', 'Nhà cung cấp đã ngừng giao dịch');
        }
        await moveStock(row, 'send', lines, actor.accountId);
        Object.assign(set, { approvedBy: actor.accountId, approvedAt: now, selfApproved, sentBy: actor.accountId, sentAt: now });
        break;
      case 'record_refund': {
        const amount = input.refundAmount;
        if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1 || amount > MAX_REFUND) {
          throw invalid({ refundAmount: 'Nhập số tiền NCC hoàn (đồng, từ 1)' }, 'refund_required');
        }
        Object.assign(set, { refundAmount: new Decimal(amount).toFixed(2) });
        break;
      }
      case 'record_rejected':
        await moveStock(row, 'back', lines, actor.accountId);
        break;
      case 'cancel': {
        if (input.cancelDecision !== 'restock' && input.cancelDecision !== 'write_off') {
          throw invalid({ cancelDecision: 'Chọn nhập lại tồn hoặc xuất huỷ' }, 'cancel_decision_required');
        }
        set.cancelDecision = input.cancelDecision;
        set.statusReason = reason;
        // Phiếu chưa gửi nên hàng vẫn ở chờ xử lý: nhập lại tồn theo giá vốn dòng gốc, hoặc lập xuất huỷ nháp.
        if (input.cancelDecision === 'restock') await moveStock(row, 'restock', lines, actor.accountId);
        else {
          await createQuarantineWriteOff(
            { type: 'supplier_return', id: row.id, number: row.number },
            lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
            `Huỷ phiếu trả NCC ${row.number}`,
            actor.accountId,
          );
        }
        break;
      }
    }
    if (isResultAction(action)) Object.assign(set, { resultBy: actor.accountId, resultAt: now, resultSelfApproved: selfApproved });

    const updated = await updateReturn(row.id, row.version, set);
    if (!updated) throw await conflict(row, actor);
    await recordTransition({
      entityType: RETURN_ENTITY,
      entityId: row.id,
      from: row.status,
      to,
      action,
      actorId: actor.accountId,
      reason,
      selfApproved,
      audit: { entityType: AUDIT_ENTITY, label: row.number },
    });
    if (action === 'record_refund') {
      await publishEvent({
        type: 'purchasing.supplier_return_refunded',
        aggregateId: row.id,
        payload: { supplierReturnId: row.id, supplierId: row.supplierId!, refundAmount: updated.refundAmount!, recordedAt: now.toISOString() },
      });
    }
    return detail(updated, actor);
  });
}

/**
 * Đề nghị bù hàng (`sourceReturnId`, §16.2): phiếu trả phải `replaced` và chưa có đề nghị bù. Gọi trong giao dịch lập đề
 * nghị; trả lỗi theo ô hoặc `null` khi hợp lệ.
 */
export async function checkReplacementSource(sourceReturnId: string, supplierId: string | null): Promise<string | null> {
  const row = isUuid(sourceReturnId) ? await findReturn(sourceReturnId, 'update') : undefined;
  if (!row) return 'Không có phiếu trả NCC này';
  if (row.status !== 'replaced') return 'Chỉ lập đề nghị bù hàng cho phiếu trả NCC đã ghi NCC bù hàng';
  if (row.replacementRequestId) return 'Phiếu trả NCC này đã có đề nghị bù hàng';
  if (supplierId && row.supplierId !== supplierId) return 'Đề nghị bù hàng phải cùng nhà cung cấp với phiếu trả';
  return null;
}

/** Gắn đề nghị bù hàng vào phiếu trả (cùng giao dịch lập đề nghị). */
export async function linkReplacement(sourceReturnId: string, requestId: string): Promise<void> {
  const row = (await findReturn(sourceReturnId, 'update'))!;
  await updateReturn(row.id, row.version, { replacementRequestId: requestId });
}

export type { SupplierReturnStatus };
