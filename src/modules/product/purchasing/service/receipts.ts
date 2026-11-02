// Phiếu nhận: lập, kiểm đếm, xem (Documents/21 mục 16.2, spec #109 mục 6.4, 6.7). Ghi sổ ở `receipt-actions.ts`.
import { recordAudit, recordTransition } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import { nextDocNumber } from '../../inventory/index.ts';
import { type CountLine, countErrors, type DeliveryMode, toDbMode } from '../domain/receipt.ts';
import { docNumber, outstanding } from '../domain/request.ts';
import {
  findReceipt,
  insertReceipt,
  insertReceiptLines,
  listReceipts,
  lockReceipt,
  type ReceiptFilter,
  type ReceiptLineRow,
  receiptLines,
  type ReceiptRow,
  updateReceiptHeader,
  updateReceiptLine,
} from '../repository/receipts.ts';
import { findLines, type LineRow, lockLines, lockRequest, type RequestRow } from '../repository/requests.ts';
import { toReceiptDetail, toReceiptSummaries, type GoodsReceiptView } from './receipt-views.ts';
import { type Actor, invalid, notFound } from './request-views.ts';

export const RECEIPT_ENTITY = 'goods_receipts';
const AUDIT_ENTITY = 'product.goods_receipts';

/**
 * Phiếu của công ty cùng đề nghị và các dòng đề nghị, đã khoá theo thứ tự đề nghị → dòng → phiếu (spec #108 Q10);
 * không thấy thì 404. Phiếu không đổi đề nghị, nên đọc `request_id` trước khi khoá vẫn đúng.
 */
export async function lockOwnReceipt(id: string): Promise<{ receipt: ReceiptRow; request: RequestRow; requestLines: LineRow[] }> {
  const found = isUuid(id) ? await findReceipt(id) : undefined;
  if (!found) throw notFound('phiếu nhận');
  const request = (await lockRequest(found.requestId))!;
  const requestLines = await lockLines(request.id);
  const receipt = (await lockReceipt(id))!;
  return { receipt, request, requestLines };
}

/** `version` gửi lên khác bản đang khoá: 409 kèm bản mới nhất (N7). */
export async function assertReceiptVersion(row: ReceiptRow, version: number): Promise<void> {
  if (row.version !== version) {
    throw new AppError(409, 'version_conflict', 'Phiếu vừa được người khác sửa hoặc ghi sổ', { current: await toReceiptDetail(row) });
  }
}

export async function listReceiptPage(actor: Actor, q: ReceiptFilter) {
  return withCompany(actor.companyId, async () => {
    const { rows, total } = await listReceipts(q);
    return { items: await toReceiptSummaries(rows), total, page: q.page, pageSize: q.pageSize };
  });
}

export async function getReceipt(actor: Actor, id: string): Promise<GoodsReceiptView> {
  return withCompany(actor.companyId, async () => {
    const row = isUuid(id) ? await findReceipt(id) : undefined;
    if (!row) throw notFound('phiếu nhận');
    return toReceiptDetail(row);
  });
}

/**
 * Lập phiếu khi hàng tới: đề nghị phải đã đặt NCC hoặc đang nhận một phần; mỗi dòng còn chờ thành một dòng phiếu với
 * mọi số bằng 0 (spec #109 Q4). Khoá đề nghị trước để không chạy đua với huỷ, đóng thiếu.
 */
export async function createReceipt(actor: Actor, input: { requestId: string; deliveryMode: DeliveryMode; note: string }) {
  return withCompany(actor.companyId, async () => {
    const request = isUuid(input.requestId) ? await lockRequest(input.requestId) : undefined;
    if (!request) throw invalid({ requestId: 'Chọn đề nghị nhập' });
    if (request.status !== 'ordered' && request.status !== 'partially_received') {
      throw new AppError(409, 'invalid_transition', 'Đề nghị chưa đặt NCC hoặc đã đóng', { current: request.status });
    }
    const lines = (await findLines([request.id])).filter((l) => l.variantId && outstanding(l) > 0);
    if (!lines.length) throw new AppError(409, 'empty_document', 'Đề nghị không còn hàng chờ');

    const note = input.note.trim() || null;
    const deliveryMode = toDbMode(input.deliveryMode);
    const id = await insertReceipt({
      companyId: actor.companyId,
      number: docNumber('NH', await nextDocNumber('goods_receipt')),
      requestId: request.id,
      deliveryMode,
      note,
      createdBy: actor.accountId,
    });
    await insertReceiptLines(
      actor.companyId,
      id,
      lines.map((l) => ({ requestLineId: l.id, variantId: l.variantId! })),
    );
    await recordTransition({ entityType: RECEIPT_ENTITY, entityId: id, from: null, to: 'counting', action: 'create', actorId: actor.accountId });
    await recordAudit({
      companyId: actor.companyId,
      actorId: actor.accountId,
      action: 'create',
      entityType: AUDIT_ENTITY,
      entityId: id,
      before: null,
      after: { requestId: request.id, deliveryMode, note, requestLineIds: lines.map((l) => l.id) },
    });
    return toReceiptDetail((await findReceipt(id))!);
  });
}

export interface CountInput {
  deliveryMode: DeliveryMode;
  note: string;
  attachmentIds: readonly string[];
  lines: readonly (CountLine & { lineId: string })[];
  version: number;
}

const snapshot = (row: { deliveryMode: string; note: string | null }, lines: readonly ReceiptLineRow[]) => ({
  deliveryMode: row.deliveryMode,
  note: row.note,
  lines: lines.map((l) => ({
    lineId: l.requestLineId,
    announced: l.declaredQty,
    accepted: l.acceptedQty,
    defectKept: l.defectiveQty,
    returnedOnSpot: l.returnedOnSpotQty,
    reason: l.reason,
  })),
});

/** Lưu số kiểm đếm khi phiếu đang kiểm. `lines[].lineId` là id dòng đề nghị; dòng không gửi giữ số cũ. */
export async function updateReceiptCount(actor: Actor, id: string, input: CountInput): Promise<GoodsReceiptView> {
  return withCompany(actor.companyId, async () => {
    const { receipt, requestLines } = await lockOwnReceipt(id);
    await assertReceiptVersion(receipt, input.version);
    if (receipt.status !== 'counting') throw new AppError(409, 'not_draft', 'Chỉ sửa được phiếu đang kiểm');

    const lines = await receiptLines([id]);
    const byRequestLine = new Map(lines.map((l) => [l.requestLineId, l]));
    const errors: Record<string, string> = {};
    // Tệp đính kèm cần upload của #114: không nhận rồi bỏ đi trong im lặng (spec #109 Q10).
    if (input.attachmentIds.length) errors.attachments = 'Chưa nhận tệp đính kèm (chờ #114)';
    const seen = new Set<string>();
    input.lines.forEach((x, i) => {
      if (!byRequestLine.has(x.lineId)) errors[`lines.${i}.lineId`] = 'Dòng không thuộc phiếu';
      else if (seen.has(x.lineId)) errors[`lines.${i}.lineId`] = 'Dòng bị lặp';
      seen.add(x.lineId);
      Object.assign(errors, countErrors(x, i));
    });
    if (Object.keys(errors).length) throw invalid(errors);

    // Kiểm sớm theo còn chờ hiện tại; kiểm chắc chắn ở bước ghi sổ (phiếu khác có thể ghi sổ trước).
    const byId = new Map(requestLines.map((l) => [l.id, l]));
    const over: Record<string, string> = {};
    input.lines.forEach((x, i) => {
      const left = outstanding(byId.get(x.lineId)!);
      if (x.accepted + x.defectKept > left) over[`lines.${i}.accepted`] = `Còn chờ ${left}, nhận đạt và lỗi giữ không được vượt`;
    });
    if (Object.keys(over).length) throw invalid(over, 'over_outstanding');

    for (const x of input.lines) {
      await updateReceiptLine(byRequestLine.get(x.lineId)!.id, {
        declaredQty: x.announced,
        acceptedQty: x.accepted,
        defectiveQty: x.defectKept,
        returnedOnSpotQty: x.returnedOnSpot,
        reason: x.reason.trim() || null,
      });
    }
    const note = input.note.trim() || null;
    const deliveryMode = toDbMode(input.deliveryMode);
    await updateReceiptHeader(id, { deliveryMode, note });
    await recordAudit({
      companyId: actor.companyId,
      actorId: actor.accountId,
      action: 'update',
      entityType: AUDIT_ENTITY,
      entityId: id,
      before: snapshot(receipt, lines),
      after: snapshot({ deliveryMode, note }, await receiptLines([id])),
    });
    return toReceiptDetail((await findReceipt(id))!);
  });
}
