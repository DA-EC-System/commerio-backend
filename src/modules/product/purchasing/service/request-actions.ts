// Thao tác theo máy trạng thái của đề nghị nhập (Documents/21 mục 16.3, spec #108 mục 6.4, 6.6).
import { canSelfApprove, publishEvent, recordTransition } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { createPurchaseProducts } from '../../catalog/index.ts';
import { outstanding } from '../domain/request.ts';
import { purchaseRequestMachine, REQUEST_USER_ACTIONS } from '../domain/request-machine.ts';
import { findLines, findRequest, type LineRow, receiptsOf, type RequestRow, updateLine, updateRequest } from '../repository/requests.ts';
import { findSupplier } from '../repository/suppliers.ts';
import { type Actor, invalid, notFound, type PurchaseRequestView, toDetail } from './request-views.ts';
import { assertVersion, ENTITY, lockOwnRequest } from './requests.ts';
import { checkTransition } from './transitions.ts';

export interface ActionInput {
  version: number;
  reason?: string | null | undefined;
  /** Chỉ dùng khi `order`: ngày NCC hẹn giao, `yyyy-mm-dd`. */
  expectedDeliveryDate?: string | null | undefined;
}

type UserAction = (typeof REQUEST_USER_ACTIONS)[number];
const isUserAction = (a: string): a is UserAction => (REQUEST_USER_ACTIONS as readonly string[]).includes(a);

/** Mọi dòng còn hiệu lực phải có giá nhập > 0 khi gửi duyệt (Documents/25 §3.2); nháp được để 0. */
function assertPriced(lines: readonly LineRow[]): void {
  const errors: Record<string, string> = {};
  lines.forEach((l, i) => {
    if (!l.excluded && Number(l.unitPrice) <= 0) errors[`lines.${i}.unitCost`] = 'Nhập giá nhập';
  });
  if (Object.keys(errors).length) throw invalid(errors);
}

async function assertSupplierActive(row: RequestRow): Promise<void> {
  const supplier = row.supplierId ? await findSupplier(row.supplierId) : undefined;
  if (!supplier?.active) {
    throw new AppError(422, 'supplier_inactive', 'Nhà cung cấp đã ngừng giao dịch', { errors: { supplierId: 'Nhà cung cấp đã ngừng giao dịch' } });
  }
}

/** Duyệt: dòng sản phẩm mới sinh sản phẩm và SKU (Documents/25 §3.2); tên vừa bị dùng thì 422 và rollback cả lần duyệt. */
async function createNewProducts(actor: Actor, row: RequestRow, lines: readonly LineRow[]): Promise<void> {
  const pending = lines.flatMap((l, i) => (!l.excluded && !l.variantId && l.newProductName ? [{ l, i }] : []));
  if (!pending.length) return;
  const items = pending.map(({ l }) => ({ name: l.newProductName!, categoryId: l.newCategoryId! }));
  const result = await createPurchaseProducts(actor, items, `Tạo từ đề nghị nhập ${row.number}`);
  if (!result.ok) {
    const errors: Record<string, string> = {};
    for (const [k, e] of result.errors) errors[`lines.${pending[k]!.i}.newProduct.${e.field}`] = e.message;
    throw invalid(errors);
  }
  for (const [k, { l }] of pending.entries()) await updateLine(l.id, { variantId: result.variantIds[k]! });
}

/**
 * Đóng thiếu: phần còn chờ của mỗi dòng chuyển sang đã đóng thiếu, đang về giảm đúng phần đó (Documents/25 §3.2).
 * Phiếu nhận ở Giao thiếu tự sang Đã xử lý ở #109.
 */
async function closeShortLines(lines: readonly LineRow[]): Promise<void> {
  for (const l of lines) {
    const left = outstanding(l);
    if (left > 0) await updateLine(l.id, { closedShortQty: l.closedShortQty + left });
  }
}

export async function runRequestAction(actor: Actor, id: string, action: string, input: ActionInput): Promise<PurchaseRequestView> {
  return withCompany(actor.companyId, async () => {
    const row = await lockOwnRequest(id);
    if (!isUserAction(action)) throw notFound('thao tác');
    await assertVersion(row, input.version, actor);

    const lines = await findLines([id]);
    const receipts = (await receiptsOf([id])).filter((r) => r.status !== 'cancelled');
    const record = {
      createdBy: row.createdBy,
      lineCount: lines.length,
      activeLines: lines.filter((l) => !l.excluded).length,
      receiptCount: receipts.length,
      countingReceipts: receipts.filter((r) => r.status === 'counting').length,
    };
    const reason = input.reason?.trim() || null;
    // Hỏi `canSelfApprove` chỉ khi người làm là người lập: chỉ lúc đó bước cần người thứ hai mới xét tự duyệt.
    const canSelf = row.createdBy === actor.accountId && (await canSelfApprove(actor.accountId));
    const ctx = { actor, record, reason, canSelfApprove: canSelf };
    const { to, selfApproved } = await checkTransition(purchaseRequestMachine, row.status, action, ctx, () => toDetail(row, actor));

    const now = new Date();
    const set: Parameters<typeof updateRequest>[1] = { status: to };
    switch (action) {
      case 'submit':
      case 'resubmit':
        await assertSupplierActive(row);
        assertPriced(lines);
        break;
      case 'approve':
        await createNewProducts(actor, row, lines);
        Object.assign(set, { approvedBy: actor.accountId, approvedAt: now, selfApproved });
        break;
      case 'request_changes':
      case 'reject':
      case 'cancel':
        set.statusReason = reason;
        break;
      case 'order':
        Object.assign(set, { orderedBy: actor.accountId, orderedAt: now, expectedDeliveryDate: input.expectedDeliveryDate ?? null });
        break;
      case 'close_short':
        await closeShortLines(lines);
        Object.assign(set, { closedBy: actor.accountId, closedAt: now, statusReason: reason });
        break;
    }

    await updateRequest(id, set);
    await recordTransition({ entityType: ENTITY, entityId: id, from: row.status, to, action, actorId: actor.accountId, reason });
    if (action === 'submit' || action === 'resubmit') {
      await publishEvent({ type: 'purchasing.request_submitted', aggregateId: id, payload: { requestId: id, number: row.number } });
    }
    return toDetail((await findRequest(id))!, actor);
  });
}
