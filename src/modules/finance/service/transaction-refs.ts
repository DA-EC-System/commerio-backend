// Phiếu thu, khoản thu chưa khớp của giao dịch cổng cho `GET /payment/transactions*` (§12.8 `PaymentTransaction`).
// src/wiring.ts tiêm hàm này vào payment qua `ctx.financeRefsOf` (plan #27 A21): payment không import finance.
import type { TransactionRefsLookup } from '../../payment/index.ts';
import { findRefsOfTransactions } from '../repository/receipts.ts';

export const getTransactionRefs: TransactionRefsLookup = async (transactionIds) => {
  const refs = transactionIds.length > 0 ? await findRefsOfTransactions(transactionIds) : { receipts: [], unmatched: [] };
  const receiptOf = new Map(refs.receipts.map((r) => [r.txnId, { id: r.id, number: r.number }]));
  const unmatchedOf = new Map(refs.unmatched.map((u) => [u.txnId, u.id]));
  return new Map(
    transactionIds.map((id) => [id, { receipt: receiptOf.get(id) ?? null, unmatchedReceiptId: unmatchedOf.get(id) ?? null }]),
  );
};
