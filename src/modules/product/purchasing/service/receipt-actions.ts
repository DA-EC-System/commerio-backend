// Thao tác theo máy trạng thái của phiếu nhận (Documents/21 mục 16.3, spec #109 mục 6.4–6.6).
import { canSelfApprove, publishEvent, recordTransition } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { nextDocNumber, receiveGoods } from '../../inventory/index.ts';
import { goodsReceiptMachine, RECEIPT_USER_ACTIONS } from '../domain/receipt-machine.ts';
import { docNumber, outstanding } from '../domain/request.ts';
import { findReceipt, type ReceiptLineRow, receiptLines, type ReceiptRow, updateReceipt } from '../repository/receipts.ts';
import { type LineRow, type RequestRow, updateLine } from '../repository/requests.ts';
import { insertDraftReturn, insertReturnLines } from '../repository/returns.ts';
import { type GoodsReceiptView, toReceiptDetail } from './receipt-views.ts';
import { assertReceiptVersion, lockOwnReceipt, RECEIPT_ENTITY } from './receipts.ts';
import { applyReceiving } from './request-receiving.ts';
import { type Actor, invalid, notFound } from './request-views.ts';
import { checkTransition } from './transitions.ts';

type UserAction = (typeof RECEIPT_USER_ACTIONS)[number];
const isUserAction = (a: string): a is UserAction => (RECEIPT_USER_ACTIONS as readonly string[]).includes(a);

const shortOfReceipt = (lines: readonly ReceiptLineRow[]) => lines.reduce((s, l) => s + l.shortageQty, 0);

/** Hàng lỗi giữ lại thành phiếu trả NCC nháp do hệ thống lập (spec #109 Q8); máy trạng thái phiếu trả làm ở B4. */
async function draftReturn(actor: Actor, receipt: ReceiptRow, request: RequestRow, defects: readonly { line: ReceiptLineRow; unitCost: string }[]) {
  const id = await insertDraftReturn({
    companyId: actor.companyId,
    number: docNumber('TN', await nextDocNumber('supplier_return')),
    supplierId: request.supplierId,
    sourceId: receipt.id,
  });
  await insertReturnLines(
    actor.companyId,
    id,
    defects.map(({ line, unitCost }) => ({ variantId: line.variantId, quantity: line.defectiveQty, unitCost, sourceLineId: line.id })),
  );
  await recordTransition({ entityType: 'supplier_returns', entityId: id, from: null, to: 'draft', action: 'create', actorId: null });
}

/**
 * Ghi sổ (spec #109 mục 6.5): kiểm lại còn chờ sau khi đã khoá các dòng đề nghị, cộng số nhận, đổi tồn qua inventory,
 * lập phiếu trả NCC nháp cho hàng lỗi, chuyển phiếu và đề nghị, phát `goods_receipt_posted`. Một giao dịch.
 */
async function post(
  actor: Actor,
  action: 'post' | 'post_short',
  locked: { receipt: ReceiptRow; request: RequestRow; requestLines: LineRow[] },
): Promise<void> {
  const { receipt, request, requestLines } = locked;
  const lines = await receiptLines([receipt.id]);
  // Hỏi `canSelfApprove` chỉ khi người ghi sổ là người lập đề nghị.
  const canSelf = request.createdBy === actor.accountId && (await canSelfApprove(actor.accountId));
  const record = { createdBy: request.createdBy, short: shortOfReceipt(lines) };
  const { to, selfApproved } = await checkTransition(goodsReceiptMachine, receipt.status, action, { actor, record, canSelfApprove: canSelf }, () =>
    toReceiptDetail(receipt),
  );
  if (!lines.some((l) => l.declaredQty > 0)) throw new AppError(409, 'empty_document', 'Phiếu chưa có số báo giao');

  const byId = new Map(requestLines.map((l) => [l.id, l]));
  const over: Record<string, string> = {};
  lines.forEach((l, i) => {
    const left = outstanding(byId.get(l.requestLineId)!);
    if (l.acceptedQty + l.defectiveQty > left) over[`lines.${i}.accepted`] = `Còn chờ ${left}, nhận đạt và lỗi giữ không được vượt`;
  });
  if (Object.keys(over).length) throw invalid(over, 'over_outstanding');

  const moved = lines.flatMap((line) => {
    const requestLine = byId.get(line.requestLineId)!;
    return line.acceptedQty + line.defectiveQty > 0 ? [{ line, requestLine, unitCost: requestLine.unitPrice }] : [];
  });
  for (const { line, requestLine } of moved) {
    await updateLine(requestLine.id, {
      receivedQty: requestLine.receivedQty + line.acceptedQty,
      defectiveQty: requestLine.defectiveQty + line.defectiveQty,
    });
  }
  await receiveGoods(
    receipt.id,
    moved.map(({ line, unitCost }) => ({ lineId: line.id, variantId: line.variantId, accepted: line.acceptedQty, defective: line.defectiveQty, unitCost })),
    actor.accountId,
  );
  const defects = moved.filter(({ line }) => line.defectiveQty > 0);
  if (defects.length) await draftReturn(actor, receipt, request, defects);

  await updateReceipt(receipt.id, { status: to, postedBy: actor.accountId, postedAt: new Date(), selfApproved });
  await recordTransition({ entityType: RECEIPT_ENTITY, entityId: receipt.id, from: receipt.status, to, action, actorId: actor.accountId });
  await applyReceiving(request, { receiptId: receipt.id, actorId: actor.accountId });
  await publishEvent({
    type: 'purchasing.goods_receipt_posted',
    aggregateId: receipt.id,
    payload: {
      receiptId: receipt.id,
      requestId: request.id,
      lines: moved.map(({ line }) => ({ variantId: line.variantId, accepted: line.acceptedQty, defective: line.defectiveQty })),
    },
  });
}

export async function runReceiptAction(
  actor: Actor,
  id: string,
  action: string,
  input: { version: number; reason?: string | null | undefined },
): Promise<GoodsReceiptView> {
  return withCompany(actor.companyId, async () => {
    const locked = await lockOwnReceipt(id);
    const { receipt, request } = locked;
    if (!isUserAction(action)) throw notFound('thao tác');
    await assertReceiptVersion(receipt, input.version);

    if (action === 'post' || action === 'post_short') {
      await post(actor, action, locked);
    } else {
      const reason = input.reason?.trim() || null;
      const record = { createdBy: request.createdBy, short: shortOfReceipt(await receiptLines([id])) };
      const { to } = await checkTransition(goodsReceiptMachine, receipt.status, action, { actor, record, reason }, () =>
        toReceiptDetail(receipt),
      );
      await updateReceipt(id, { status: to, statusReason: reason });
      await recordTransition({ entityType: RECEIPT_ENTITY, entityId: id, from: receipt.status, to, action, actorId: actor.accountId, reason });
    }
    return toReceiptDetail((await findReceipt(id))!);
  });
}
