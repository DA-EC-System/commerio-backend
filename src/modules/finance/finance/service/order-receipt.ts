// Đơn trả trước nhận đủ tiền (webhook, gán khoản thu chưa khớp): `payment.markPaid` → phiếu thu → sự kiện
// `payment.succeeded`, `finance.receipt_posted`, trong giao dịch `withCompany` đang mở; bên gọi đã khoá dòng đơn (A4).
import type { Decimal } from 'decimal.js';
import { type Gateway, markPaid } from '../../payment/index.ts';
import { publishEvent } from '../../../core/index.ts';
import { insertReceipt, type ReceiptRow } from '../repository/receipts.ts';
import { nextDocNumber } from './doc-numbers.ts';

export async function postOrderReceipt(p: {
  companyId: string;
  orderId: string;
  source: 'gateway' | 'unmatched_assignment';
  amount: Decimal | string;
  gateway: Gateway | null;
  paymentTransactionId: string | null;
  paymentLinkId: string | null;
  unmatchedReceiptId?: string;
}): Promise<ReceiptRow> {
  await markPaid(p.orderId, { paymentTransactionId: p.paymentTransactionId, paymentLinkId: p.paymentLinkId });
  const receipt = await insertReceipt({
    companyId: p.companyId,
    number: await nextDocNumber('receipt'),
    orderId: p.orderId,
    source: p.source,
    paymentTransactionId: p.source === 'gateway' ? p.paymentTransactionId : null,
    unmatchedReceiptId: p.unmatchedReceiptId ?? null,
    amount: typeof p.amount === 'string' ? p.amount : p.amount.toFixed(2),
  });
  if (p.paymentTransactionId && p.gateway) {
    await publishEvent({
      type: 'payment.succeeded',
      aggregateId: p.orderId,
      payload: { orderId: p.orderId, paymentTransactionId: p.paymentTransactionId, gateway: p.gateway, amount: receipt.amount },
    });
  }
  await publishEvent({
    type: 'finance.receipt_posted',
    aggregateId: receipt.id,
    payload: {
      receiptId: receipt.id,
      orderId: p.orderId,
      amount: receipt.amount,
      source: p.source,
      postedAt: receipt.postedAt.toISOString(),
      reversalOf: null,
    },
  });
  return receipt;
}
