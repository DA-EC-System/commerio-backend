import { z } from 'zod';
import { DocRef, OrderRef, page, pageOf, range } from './schemas.ts';

// Hợp đồng đối soát tiền sàn (Documents/21 §12.6, §12.8; plan #30). Tiền là số nguyên đồng (T1).

// Đối soát không có ô tìm kiếm (§12.6).
const paging = { page: page.page, pageSize: page.pageSize };
const uuid = (label: string) => z.uuid(`${label} không hợp lệ`).optional();

export const SettlementListQuery = z.object({
  ...paging,
  ...range,
  shopId: uuid('Gian hàng'),
  paymentStatus: z.string().trim().max(30, 'Trạng thái trả tiền tối đa 30 ký tự').optional(),
});

export const SettlementLineListQuery = z.object({
  ...paging,
  ...range,
  statementId: uuid('Bảng kê'),
  matchStatus: z.enum(['matched', 'discrepancy', 'refund_tagged'], 'Trạng thái khớp không hợp lệ').optional(),
  shopId: uuid('Gian hàng'),
  orderId: uuid('Đơn'),
});

/**
 * Nhận bảng kê khuôn OAS TikTok (chỉ dev/E2E, plan #30 A2). `statement`: một phần tử `statements[]` của
 * `GET /finance/202309/statements`; `transactions`: `transactions[]` của `GET /finance/202501/statements/{id}/statement_transactions`.
 * Trường tiền, mã kiểm khi ánh xạ (lỗi theo ô `statement.<trường>`, `transactions.<i>.<trường>`).
 */
export const SettlementImportBody = z
  .object({
    shopId: z.uuid('Gian hàng không hợp lệ'),
    statement: z.looseObject({}),
    transactions: z.array(z.looseObject({})).max(200, 'Tối đa 200 giao dịch mỗi lần nhận'),
  })
  .meta({ id: 'SettlementImportBody' });

const money = z.number().int();
const Shop = z.object({ id: z.uuid(), shopName: z.string().nullable(), platform: z.string().nullable() });

export const SettlementStatement = z
  .object({
    id: z.uuid(),
    shop: Shop,
    externalStatementId: z.string(),
    statementTime: z.string(),
    settlementAmount: money,
    paymentStatus: z.string().meta({ description: 'Giữ nguyên chữ của sàn: PAID, FAILED, PROCESSING…' }),
    lineCount: z.number().int(),
    matchedCount: z.number().int(),
    discrepancyCount: z.number().int(),
    refundTaggedCount: z.number().int(),
    receiptTotal: money,
  })
  .meta({ id: 'SettlementStatement' });

const SettlementFees = z
  .object({
    commission: money,
    transactionFee: money,
    infrastructureFee: money,
    affiliate: money,
    campaign: money,
    tax: money,
    other: money,
  })
  .meta({ id: 'SettlementFees', description: 'Chi phí dương = sàn thu; âm = sàn hoàn phí (plan #30 A3)' });

const SettlementLine = z
  .object({
    id: z.uuid(),
    statementId: z.uuid(),
    kind: z.enum(['order', 'adjustment', 'reserve']),
    externalTransactionId: z.string(),
    externalOrderId: z.string().nullable(),
    order: OrderRef.nullable(),
    revenue: money,
    fees: SettlementFees,
    feeTotal: money,
    shippingCost: money,
    adjustment: money.meta({ description: 'Dương = sàn trả thêm' }),
    settlement: money,
    orderTotal: money.nullable(),
    matchStatus: z.enum(['matched', 'discrepancy', 'refund_tagged']),
    discrepancyReason: z.enum(['order_not_found', 'revenue_mismatch', 'formula_mismatch']).nullable(),
    receipt: DocRef.nullable(),
    receiptPending: z.boolean().meta({ description: 'Dòng đủ điều kiện phiếu thu nhưng bảng kê chưa PAID' }),
  })
  .meta({ id: 'SettlementLine' });

export const SettlementPage = pageOf(SettlementStatement, 'SettlementStatementPage');
export const SettlementLinePage = pageOf(SettlementLine, 'SettlementLinePage');
