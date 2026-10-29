// Thao tác theo máy trạng thái của phiếu nhận (Documents/21 mục 16.3, spec #109 mục 6.4–6.6).
import { recordTransition } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { notImplemented } from '../../../../shared/errors/app-error.ts';
import { goodsReceiptMachine, RECEIPT_USER_ACTIONS } from '../domain/receipt-machine.ts';
import { findReceipt, receiptLines, updateReceipt } from '../repository/receipts.ts';
import { type GoodsReceiptView, toReceiptDetail } from './receipt-views.ts';
import { assertReceiptVersion, lockOwnReceipt, RECEIPT_ENTITY } from './receipts.ts';
import { type Actor, notFound } from './request-views.ts';
import { checkTransition } from './transitions.ts';

type UserAction = (typeof RECEIPT_USER_ACTIONS)[number];
const isUserAction = (a: string): a is UserAction => (RECEIPT_USER_ACTIONS as readonly string[]).includes(a);

export async function runReceiptAction(
  actor: Actor,
  id: string,
  action: string,
  input: { version: number; reason?: string | null | undefined },
): Promise<GoodsReceiptView> {
  return withCompany(actor.companyId, async () => {
    const { receipt, request } = await lockOwnReceipt(id);
    if (!isUserAction(action)) throw notFound('thao tác');
    await assertReceiptVersion(receipt, input.version);
    if (action === 'post' || action === 'post_short') throw notImplemented(action, '#109 PR B');

    const reason = input.reason?.trim() || null;
    const lines = await receiptLines([id]);
    const record = { createdBy: request.createdBy, short: lines.reduce((s, l) => s + l.shortageQty, 0) };
    const { to } = await checkTransition(goodsReceiptMachine, receipt.status, action, { actor, record, reason }, () =>
      toReceiptDetail(receipt),
    );
    await updateReceipt(id, { status: to, statusReason: reason });
    await recordTransition({ entityType: RECEIPT_ENTITY, entityId: id, from: receipt.status, to, action, actorId: actor.accountId, reason });
    return toReceiptDetail((await findReceipt(id))!);
  });
}
