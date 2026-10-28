// Nhận một bảng kê thanh toán của sàn (UC-PF-10; plan #30 A9, Documents/21 T23–T26): lưu, khớp từng dòng với đơn sàn,
// gắn nhãn hoàn, khớp lại dòng chưa thấy đơn. Gọi trong `withCompany` của bên gọi; một giao dịch cho cả lần nhận.
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { requireCompanyId } from '../../../../shared/db/client.ts';
import { publishEvent } from '../../../core/index.ts';
import { findMarketplaceOrders } from '../../../order/index.ts';
import { matchLine } from '../domain/settlement-match.ts';
import {
  FEE_KEYS,
  mapTikTokTransaction,
  type SettlementLineInput,
  type SettlementStatementInput,
  type TikTokTransaction,
} from '../domain/tiktok-settlement.ts';
import { insertReceipt } from '../repository/receipts.ts';
import {
  findLinesAwaitingReceipt,
  findOrderNotFoundLines,
  findStatementByExternalId,
  insertLinesIgnoringExisting,
  insertStatement,
  lockCompanySettlements,
  updateLineMatch,
  updateStatement,
} from '../repository/settlements.ts';
import { nextDocNumber } from './doc-numbers.ts';

const feesJson = (fees: SettlementLineInput['fees']) =>
  Object.fromEntries(FEE_KEYS.map((k) => [k, fees[k].toFixed(2)]));

/** Upsert bảng kê theo mã của sàn; bảng kê đã có thuộc gian hàng khác → 422. */
async function upsertStatement(companyId: string, shopId: string, input: SettlementStatementInput) {
  const existing = await findStatementByExternalId(input.externalStatementId);
  const values = {
    statementTime: input.statementTime,
    settlementAmount: input.settlementAmount.toFixed(2),
    paymentStatus: input.paymentStatus,
  };
  if (!existing) {
    return {
      id: await insertStatement({ companyId, shopId, externalStatementId: input.externalStatementId, ...values }),
      created: true,
    };
  }
  if (existing.shopId !== shopId) {
    throw new AppError(422, 'validation_failed', 'Dữ liệu gửi lên không hợp lệ', {
      errors: { shopId: 'Bảng kê này đã nhận cho gian hàng khác' },
    });
  }
  const changed =
    existing.paymentStatus !== values.paymentStatus ||
    existing.settlementAmount !== values.settlementAmount ||
    existing.statementTime.getTime() !== values.statementTime.getTime();
  if (existing.paymentStatus === 'PAID' && values.paymentStatus !== 'PAID') {
    // Phiếu thu đã sinh không tự đảo (chứng từ đảo là UC-PF-09, chưa có issue): để người xem lại (plan #30 7b).
    logger.warn({ statementId: existing.id, paymentStatus: values.paymentStatus }, 'bảng kê đã PAID đổi trạng thái');
  }
  if (changed) await updateStatement(existing.id, values);
  return { id: existing.id, created: false };
}

/** Khớp lại mọi dòng chưa thấy đơn của công ty (T26, AC-7b): đơn sàn có thể về sau bảng kê. */
async function rematchOrderNotFound(): Promise<void> {
  const pending = await findOrderNotFoundLines();
  const byShop = Map.groupBy(pending, (l) => l.shopId);
  for (const [shopId, lines] of byShop) {
    const mapped = lines.map((l) => ({ id: l.id, line: mapTikTokTransaction(l.raw as TikTokTransaction) }));
    const orders = await findMarketplaceOrders(
      shopId,
      mapped.flatMap((m) => m.line.externalOrderId ?? []),
    );
    for (const { id, line } of mapped) {
      const order = line.externalOrderId ? orders.get(line.externalOrderId) : undefined;
      if (!order) continue;
      await updateLineMatch(id, { orderId: order.id, ...matchLine(line, order) });
    }
  }
}

/** Phiếu thu `settlement` cho mọi dòng đủ điều kiện còn thiếu (D19, A4), kèm sự kiện cho báo cáo (#29). */
async function postPendingReceipts(companyId: string): Promise<void> {
  for (const line of await findLinesAwaitingReceipt()) {
    const receipt = await insertReceipt({
      companyId,
      number: await nextDocNumber('receipt'),
      orderId: line.orderId,
      source: 'settlement',
      settlementLineId: line.id,
      amount: line.settlement,
    });
    await publishEvent({
      type: 'finance.receipt_posted',
      aggregateId: receipt.id,
      payload: {
        receiptId: receipt.id,
        orderId: receipt.orderId,
        amount: receipt.amount,
        source: 'settlement',
        postedAt: receipt.postedAt.toISOString(),
        reversalOf: null,
      },
    });
  }
}

/**
 * Nhận bảng kê `statement` của gian hàng `shopId` với các dòng đã ánh xạ. Nhận lại an toàn: bảng kê cập nhật trạng
 * thái, dòng đã có (theo mã giao dịch của sàn) bỏ qua.
 */
export async function ingestSettlementStatement(
  shopId: string,
  statement: SettlementStatementInput,
  lines: readonly SettlementLineInput[],
): Promise<{ statementId: string; created: boolean }> {
  const companyId = requireCompanyId('ingestSettlementStatement');
  await lockCompanySettlements(companyId);

  const { id: statementId, created } = await upsertStatement(companyId, shopId, statement);
  const unique = [...new Map(lines.map((l) => [l.externalTransactionId, l])).values()];
  const orders = await findMarketplaceOrders(
    shopId,
    unique.flatMap((l) => l.externalOrderId ?? []),
  );
  await insertLinesIgnoringExisting(
    unique.map((l) => {
      const order = l.externalOrderId ? (orders.get(l.externalOrderId) ?? null) : null;
      return {
        companyId,
        statementId,
        kind: l.kind,
        externalTransactionId: l.externalTransactionId,
        externalOrderId: l.externalOrderId,
        orderId: order?.id ?? null,
        revenue: l.revenue.toFixed(2),
        fees: feesJson(l.fees),
        shippingCost: l.shippingCost.toFixed(2),
        adjustment: l.adjustment.toFixed(2),
        settlement: l.settlement.toFixed(2),
        ...matchLine(l, order),
        raw: l.raw,
      };
    }),
  );
  await rematchOrderNotFound();
  await postPendingReceipts(companyId);
  return { statementId, created };
}
