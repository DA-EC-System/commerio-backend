// Thao tác theo máy trạng thái của phiếu nhận (Documents/21 mục 16.3, spec #109 mục 6.4–6.6).
import { canSelfApprove, hasAttachments, publishEvent, recordAudit, recordTransition } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { createPurchaseProducts, normalizeName } from '../../catalog/index.ts';
import { nextDocNumber, receiveGoods, recheckThresholds } from '../../inventory/index.ts';
import { needsEvidence } from '../domain/receipt.ts';
import { goodsReceiptMachine, RECEIPT_USER_ACTIONS } from '../domain/receipt-machine.ts';
import { docNumber, hasPermission, outstanding, variantIdsOf } from '../domain/request.ts';
import {
  findReceipt,
  findReceiptByNumber,
  type ReceiptLineRow,
  receiptLines,
  type ReceiptRow,
  updateReceipt,
  updateReceiptLine,
} from '../repository/receipts.ts';
import { type LineRow, type RequestRow, updateLine } from '../repository/requests.ts';
import { insertDraftReturn, insertReturnLines } from '../repository/returns.ts';
import { type GoodsReceiptView, toReceiptDetail } from './receipt-views.ts';
import { assertReceiptVersion, lockOwnReceipt, RECEIPT_AUDIT_ENTITY, RECEIPT_ENTITY } from './receipts.ts';
import { applyReceiving, closeShortRequest } from './request-receiving.ts';
import { type Actor, invalid, notFound } from './request-views.ts';
import { checkTransition } from './transitions.ts';

type UserAction = (typeof RECEIPT_USER_ACTIONS)[number];
const isUserAction = (a: string): a is UserAction => (RECEIPT_USER_ACTIONS as readonly string[]).includes(a);

const shortOfReceipt = (lines: readonly ReceiptLineRow[]) => lines.reduce((s, l) => s + l.shortageQty, 0);

/** Hàng lỗi giữ lại thành phiếu trả NCC nháp do hệ thống lập (spec #109 Q8); máy trạng thái phiếu trả làm ở B4. */
async function draftReturn(
  actor: Actor,
  receipt: ReceiptRow,
  request: RequestRow,
  defects: readonly { line: ReceiptLineRow & { variantId: string }; unitCost: string }[],
) {
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

const parentKey = (name: string) => normalizeName(name).toLowerCase();

/**
 * Dòng sản phẩm mới có đạt + lỗi giữ > 0 trong phiếu này mà chưa có SKU: tạo sản phẩm cha, SKU (Documents/21 mục 16.3
 * "Dòng sản phẩm mới khi ghi sổ phiếu nhận", 25 §4.2). Chạy sau khi đã khoá đề nghị và các dòng, nên hai phiếu ghi sổ
 * song song không tạo hai lần. Điền `variant_id` vào dòng đề nghị và dòng phiếu; dòng anh em cùng cha mới chưa có hàng
 * chuyển sang trỏ cha vừa tạo, để phiếu sau gắn SKU vào cùng cha. Trả dòng phiếu đã có SKU (mọi dòng có đạt hoặc lỗi).
 */
async function createReceivedProducts(
  actor: Actor,
  receipt: ReceiptRow,
  lines: readonly ReceiptLineRow[],
  requestLines: readonly LineRow[],
): Promise<(ReceiptLineRow & { variantId: string | null })[]> {
  const byId = new Map(requestLines.map((l) => [l.id, l]));
  const pending = lines.flatMap((line, i) => (!line.variantId && line.acceptedQty + line.defectiveQty > 0 ? [{ line, i, rl: byId.get(line.requestLineId)! }] : []));
  if (!pending.length) return [...lines];
  const filled = new Map<string, string>();
  // Dòng đề nghị đã có SKU (phiếu khác của cùng đề nghị ghi sổ trước, sau khi phiếu này lập) thì dùng luôn.
  for (const { line, rl } of pending) if (rl.variantId) filled.set(line.id, rl.variantId);
  const toCreate = pending.filter(({ rl }) => !rl.variantId);
  if (toCreate.length) {
    const result = await createPurchaseProducts(
      actor,
      toCreate.map(({ i, rl }) => ({
        line: i,
        lineId: rl.id,
        parentId: rl.newParentProductId,
        parentName: rl.newParentName,
        groupId: rl.newGroupId,
        options: rl.newOptionValues ?? [],
      })),
      `Tạo khi nhập kho phiếu ${receipt.number}`,
    );
    if (!result.ok) {
      const errors: Record<string, string> = {};
      for (const [k, e] of result.errors) errors[`lines.${toCreate[k]!.i}`] = e.message;
      if (result.code === 'new_product_name_taken') {
        throw new AppError(409, 'new_product_name_taken', Object.values(errors)[0]!, { errors });
      }
      throw invalid(errors, result.code);
    }
    const madeParents = new Map<string, string>();
    for (const [k, { line, rl }] of toCreate.entries()) {
      filled.set(line.id, result.variantIds[k]!);
      await updateLine(rl.id, { variantId: result.variantIds[k]! });
      if (rl.newParentName) madeParents.set(parentKey(rl.newParentName), result.productIds[k]!);
    }
    // Anh em cùng cha mới chưa có hàng: trỏ cha vừa tạo (CHECK `purchase_request_lines_one_parent`: bỏ tên, nhóm).
    const created = new Set(toCreate.map(({ rl }) => rl.id));
    for (const rl of requestLines) {
      const productId = rl.newParentName && !rl.variantId && !created.has(rl.id) ? madeParents.get(parentKey(rl.newParentName)) : undefined;
      if (productId) await updateLine(rl.id, { newParentProductId: productId, newParentName: null, newGroupId: null });
    }
    if (result.reused.length) {
      await recordAudit({
        companyId: actor.companyId,
        actorId: actor.accountId,
        action: 'update',
        entityType: RECEIPT_AUDIT_ENTITY,
        entityId: receipt.id,
        label: receipt.number,
        before: null,
        after: { reusedVariants: result.reused.map((k) => ({ requestLineId: toCreate[k]!.rl.id, variantId: result.variantIds[k]! })) },
      });
    }
  }
  for (const [lineId, variantId] of filled) await updateReceiptLine(lineId, { variantId });
  return lines.map((l) => (filled.has(l.id) ? { ...l, variantId: filled.get(l.id)! } : l));
}

/**
 * Ghi sổ (spec #109 mục 6.5): kiểm lại còn chờ sau khi đã khoá các dòng đề nghị, tạo SKU cho dòng sản phẩm mới có hàng
 * về, cộng số nhận, đổi tồn qua inventory, lập phiếu trả NCC nháp cho hàng lỗi, chuyển phiếu và đề nghị, phát
 * `goods_receipt_posted`. Một giao dịch.
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
  if (needsEvidence(receipt.deliveryMode, lines) && !(await hasAttachments({ type: RECEIPT_ENTITY, id: receipt.id }))) {
    throw new AppError(422, 'evidence_required', 'Người giao đã đi mà phiếu có hàng lỗi hoặc thiếu: đính ảnh mở thùng trước khi nhập kho');
  }

  const byId = new Map(requestLines.map((l) => [l.id, l]));
  const over: Record<string, string> = {};
  lines.forEach((l, i) => {
    const left = outstanding(byId.get(l.requestLineId)!);
    if (l.acceptedQty + l.defectiveQty > left) over[`lines.${i}.accepted`] = `Còn chờ ${left}, nhận đạt và lỗi giữ không được vượt`;
  });
  if (Object.keys(over).length) throw invalid(over, 'over_outstanding');

  const withSkus = await createReceivedProducts(actor, receipt, lines, requestLines);
  const moved = withSkus.flatMap((line) => {
    const requestLine = byId.get(line.requestLineId)!;
    // Dòng có đạt hoặc lỗi luôn có SKU sau `createReceivedProducts` (Documents/19: không còn dòng trống có hàng).
    return line.acceptedQty + line.defectiveQty > 0 ? [{ line: { ...line, variantId: line.variantId! }, requestLine, unitCost: requestLine.unitPrice }] : [];
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

  const postedAt = new Date();
  await updateReceipt(receipt.id, { status: to, postedBy: actor.accountId, postedAt, selfApproved });
  await recordTransition({
    entityType: RECEIPT_ENTITY,
    entityId: receipt.id,
    from: receipt.status,
    to,
    action,
    actorId: actor.accountId,
    selfApproved,
    audit: { entityType: RECEIPT_AUDIT_ENTITY, code: receipt.number },
  });
  await applyReceiving(request, { receiptId: receipt.id, actorId: actor.accountId });
  // Hàng lỗi và phần nhận đều làm giảm đang về, kể cả SKU không có move tồn thực (Documents/25 mục 7.5).
  await recheckThresholds([...new Set([...variantIdsOf(requestLines), ...variantIdsOf(withSkus)])]);
  await publishEvent({
    type: 'purchasing.goods_receipt_posted',
    aggregateId: receipt.id,
    payload: {
      receiptId: receipt.id,
      requestId: request.id,
      supplierId: request.supplierId!,
      postedAt: postedAt.toISOString(),
      replacement: request.sourceReturnId !== null,
      lines: moved.map(({ line, unitCost }) => ({
        variantId: line.variantId,
        accepted: line.acceptedQty,
        defective: line.defectiveQty,
        unitPrice: unitCost,
      })),
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

export interface ShortResolutionInput {
  kind: 'follow_up' | 'supplier_wrong' | 'close_short';
  followUpNumber?: string | null | undefined;
  note: string;
  version: number;
}

/**
 * Ghi kết quả giao thiếu (spec #109 mục 6.6): giao bù bằng phiếu khác cùng đề nghị, NCC nhận sai, hoặc CEO đóng thiếu
 * cả đề nghị qua `closeShortRequest` (phiếu này tự sang Đã xử lý cùng các phiếu thiếu khác).
 */
export async function resolveShort(actor: Actor, id: string, input: ShortResolutionInput): Promise<GoodsReceiptView> {
  return withCompany(actor.companyId, async () => {
    const { receipt, request } = await lockOwnReceipt(id);
    await assertReceiptVersion(receipt, input.version);
    if (receipt.status === 'resolved') throw new AppError(409, 'resolution_recorded', 'Phiếu đã ghi kết quả giao thiếu');
    const record = { createdBy: request.createdBy, short: 0 };
    const { to } = await checkTransition(goodsReceiptMachine, receipt.status, 'resolve', { actor, record }, () => toReceiptDetail(receipt));
    const note = input.note.trim();

    if (input.kind === 'close_short') {
      if (!hasPermission(actor, 'purchasing.request.approve')) throw new AppError(403, 'forbidden', 'Chỉ CEO đóng thiếu đề nghị');
      if (!note) throw invalid({ note: 'Nhập lý do đóng thiếu' }, 'reason_required');
      await closeShortRequest(actor, request, note);
      return toReceiptDetail((await findReceipt(id))!);
    }

    let followUpId: string | null = null;
    if (input.kind === 'follow_up') {
      const number = (input.followUpNumber ?? '').trim().toUpperCase();
      const found = number ? await findReceiptByNumber(request.id, number) : undefined;
      if (!found || found.id === receipt.id || found.status === 'cancelled') {
        throw invalid({ followUpNumber: 'Không có phiếu nhập kho này trong cùng đơn đặt hàng nhập' }, 'follow_up_invalid');
      }
      followUpId = found.id;
    } else if (!note) {
      throw invalid({ note: 'Ghi NCC nhận sai thế nào' });
    }

    await updateReceipt(id, {
      status: to,
      shortResolution: input.kind,
      followUpReceiptId: followUpId,
      resolutionNote: note || null,
      resolvedBy: actor.accountId,
      resolvedAt: new Date(),
    });
    await recordTransition({ entityType: RECEIPT_ENTITY, entityId: id, from: receipt.status, to, action: 'resolve', actorId: actor.accountId });
    return toReceiptDetail((await findReceipt(id))!);
  });
}
