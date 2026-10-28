// Dữ liệu dựng cho test đối soát (#30). Gian hàng (#19) và đơn sàn (#21) chưa có luồng thật: đơn tạo bằng `createOrder`
// rồi đặt gian hàng, mã đơn sàn bằng role chủ bảng (L004, ghi rõ là dữ liệu dựng); gian hàng chỉ là một uuid.
import { randomUUID } from 'node:crypto';
import {
  mapTikTokStatement,
  mapTikTokTransaction,
  type TikTokStatement,
  type TikTokTransaction,
} from '#src/modules/finance/finance/domain/tiktok-settlement.ts';
import { ingestSettlementStatement } from '#src/modules/finance/finance/service/settlement-ingest.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { testPool } from '../../helpers/db.ts';
import { createOrder } from '../../helpers/sales.ts';

/** Đơn sàn của gian hàng `shopId`, tổng `total`, mã đơn sàn ngẫu nhiên. */
export async function marketplaceOrder(companyId: string, shopId: string, total: number) {
  const v = await createVariant(companyId);
  const order = await createOrder(companyId, {
    source: 'marketplace',
    lines: [{ variantId: v.variantId, quantity: 1, unitPrice: total }],
  });
  const externalOrderId = `SO-${randomUUID().slice(0, 8)}`;
  await testPool().query('update "order".orders set shop_id = $2, external_order_id = $3 where id = $1', [
    order.orderId,
    shopId,
    externalOrderId,
  ]);
  return { orderId: order.orderId, externalOrderId };
}

/** Bảng kê khuôn OAS 202309. */
export const statement = (over: Partial<TikTokStatement> = {}): TikTokStatement => ({
  id: `ST-${randomUUID().slice(0, 8)}`,
  statement_time: 1760832000,
  settlement_amount: '0',
  payment_status: 'PAID',
  ...over,
});

/**
 * Giao dịch đơn khuôn OAS 202501, cân công thức: doanh thu `revenue`, hoa hồng 10.000, phí giao dịch 6.000, thuế
 * 1.000, vận chuyển 15.000 → tiền về `revenue − 32.000`.
 */
export function orderTx(
  externalOrderId: string,
  revenue: number,
  over: Partial<TikTokTransaction> = {},
): TikTokTransaction {
  return {
    id: `TX-${randomUUID()}`,
    type: 'ORDER',
    order_id: externalOrderId,
    revenue_amount: String(revenue),
    shipping_cost_amount: '-15000',
    fee_tax_amount: '-17000',
    fee_tax_breakdown: {
      fee: { platform_commission_amount: '-10000', transaction_fee_amount: '-6000' },
      tax: { pit_amount: '-1000' },
    },
    adjustment_amount: '0',
    settlement_amount: String(revenue - 32000),
    ...over,
  };
}

/** Nhận bảng kê như PR2 sẽ gọi: ánh xạ OAS rồi `ingestSettlementStatement` trong `withCompany`. */
export function ingest(companyId: string, shopId: string, st: TikTokStatement, txs: TikTokTransaction[]) {
  return withCompany(companyId, () =>
    ingestSettlementStatement(shopId, mapTikTokStatement(st), txs.map(mapTikTokTransaction)),
  );
}

export async function linesOf(companyId: string) {
  const { rows } = await testPool().query(
    `select l.external_transaction_id as tx, l.kind, l.order_id, l.external_order_id, l.match_status, l.discrepancy_reason,
            l.revenue, l.fees, l.shipping_cost, l.adjustment, l.settlement, l.raw, s.external_statement_id as st
       from finance.settlement_lines l join finance.settlement_statements s on s.id = l.statement_id
      where l.company_id = $1 order by l.created_at, l.external_transaction_id`,
    [companyId],
  );
  return rows;
}

export async function statementsOf(companyId: string) {
  const { rows } = await testPool().query(
    'select id, shop_id, external_statement_id, payment_status, settlement_amount, version from finance.settlement_statements where company_id = $1',
    [companyId],
  );
  return rows;
}

export async function receiptsOf(companyId: string) {
  const { rows } = await testPool().query(
    `select r.number, r.order_id, r.amount, r.source, r.status, l.external_transaction_id as tx
       from finance.receipts r join finance.settlement_lines l on l.id = r.settlement_line_id
      where r.company_id = $1 order by r.number`,
    [companyId],
  );
  return rows;
}

export async function receiptEvents(companyId: string) {
  const { rows } = await testPool().query(
    "select payload from core.outbox_messages where company_id = $1 and type = 'finance.receipt_posted'",
    [companyId],
  );
  return rows.map((r) => r.payload);
}
