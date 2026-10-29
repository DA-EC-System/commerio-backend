import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createVariant } from '../../helpers/catalog.ts';
import { createOrder } from '../../helpers/sales.ts';
import { testPool } from '../../helpers/db.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { shops } from '#src/modules/channel/channel/repository/schema.ts';
import {
  paymentVouchers,
  receipts,
  salesInvoices,
  settlementLines,
  settlementStatements,
} from '#src/modules/finance/finance/repository/schema.ts';
import { paymentTransactions } from '#src/modules/finance/payment/repository/schema.ts';
import type { OrderSource } from '#src/modules/order/sales/index.ts';
import { getDb, withCompany } from '#src/shared/db/client.ts';

// Chứng từ tài chính, dòng đối soát, giao dịch cổng ghi thẳng vào bảng trong `withCompany` (plan #29 L004): #27 (hoá
// đơn, phiếu thu, phiếu chi) chưa merge và giữ 501 cho chứng từ đảo, #30 (đối soát) chưa có. Chứng từ đảo làm đúng
// điều T21 mô tả: dòng mới số âm, `reversal_of_id` trỏ gốc, gốc sang `reversed`, cùng giao dịch.

const docNumber = (prefix: string) => `${prefix}-T${randomUUID().slice(0, 8)}`;
const money = (n: number | string) => Number(n).toFixed(2);

/**
 * Đơn đã bàn giao một kiện: nhập tồn với giá vốn, tạo đơn, rồi ghi kiện và dòng kiện đã trừ tồn với giá vốn chốt lúc
 * bàn giao (Documents/21 mục 19.2), ghi thẳng bằng role chủ bảng tới khi có API kiện (issue D2).
 */
export async function issuedOrder(
  companyId: string,
  options: { unitCost: number | string; unitPrice: number; quantity?: number; source?: OrderSource },
) {
  const quantity = options.quantity ?? 1;
  const { variantId } = await createVariant(companyId);
  await receive(companyId, variantId, quantity, options.unitCost);
  const order = await createOrder(companyId, {
    lines: [{ variantId, quantity, unitPrice: options.unitPrice }],
    ...(options.source ? { source: options.source } : {}),
  });
  const pkg = await testPool().query<{ id: string }>(
    `insert into "order".packages (company_id, code, order_id, status, handed_over_at)
     values ($1, $2, $3, 'in_transit', now()) returning id`,
    [companyId, `KH-T${randomUUID().slice(0, 8)}`, order.orderId],
  );
  await testPool().query(
    `insert into "order".package_lines (company_id, package_id, order_line_id, variant_id, quantity, unit_cost, stock_deducted)
     select $1, $2, l.id, l.variant_id, l.quantity, $4, true from "order".order_lines l where l.order_id = $3`,
    [companyId, pkg.rows[0]!.id, order.orderId, String(options.unitCost)],
  );
  return order;
}

/** Hoá đơn bán đã ghi sổ của đơn. */
export async function invoice(companyId: string, orderId: string, total: number, issuedAt: string) {
  return withCompany(companyId, async () => {
    const [row] = await getDb()
      .insert(salesInvoices)
      .values({ companyId, number: docNumber('HD'), orderId, total: money(total), issuedAt: new Date(issuedAt) })
      .returning({ id: salesInvoices.id });
    return row!.id;
  });
}

/** Hoá đơn đảo của `invoiceId` (tổng âm), gốc sang `reversed`. */
export async function reverseInvoice(companyId: string, invoiceId: string, issuedAt: string) {
  return withCompany(companyId, async () => {
    const [orig] = await getDb()
      .update(salesInvoices)
      .set({ status: 'reversed' })
      .where(eq(salesInvoices.id, invoiceId))
      .returning({ orderId: salesInvoices.orderId, total: salesInvoices.total });
    await getDb()
      .insert(salesInvoices)
      .values({
        companyId,
        number: docNumber('HD'),
        orderId: orig!.orderId,
        total: money(-Number(orig!.total)),
        issuedAt: new Date(issuedAt),
        reversalOfId: invoiceId,
        reversalReason: 'Đảo thử',
      });
  });
}

/** Phiếu thu của đơn (mặc định COD). */
export async function receipt(companyId: string, orderId: string | null, amount: number, postedAt: string) {
  return withCompany(companyId, async () => {
    const [row] = await getDb()
      .insert(receipts)
      .values({ companyId, number: docNumber('PT'), orderId, source: 'cod', amount: money(amount), postedAt: new Date(postedAt) })
      .returning({ id: receipts.id });
    return row!.id;
  });
}

/** Phiếu thu đảo của `receiptId`, gốc sang `reversed`. */
export async function reverseReceipt(companyId: string, receiptId: string, postedAt: string) {
  await withCompany(companyId, async () => {
    const [orig] = await getDb()
      .update(receipts)
      .set({ status: 'reversed' })
      .where(eq(receipts.id, receiptId))
      .returning({ orderId: receipts.orderId, amount: receipts.amount, source: receipts.source });
    await getDb()
      .insert(receipts)
      .values({
        companyId,
        number: docNumber('PT'),
        orderId: orig!.orderId,
        source: orig!.source,
        amount: money(-Number(orig!.amount)),
        postedAt: new Date(postedAt),
        reversalOfId: receiptId,
        reversalReason: 'Đảo thử',
      });
  });
}

/** Phiếu chi hoàn tiền khách (`customer_refund`), mặc định đã ghi sổ. */
export async function refund(
  companyId: string,
  orderId: string,
  amount: number,
  paidOn: string,
  status: 'draft' | 'posted' = 'posted',
) {
  return withCompany(companyId, async () => {
    const [row] = await getDb()
      .insert(paymentVouchers)
      .values({
        companyId,
        number: docNumber('PC'),
        purpose: 'customer_refund',
        orderId,
        amount: money(amount),
        paidOn,
        status,
        createdBy: randomUUID(),
        ...(status === 'posted' ? { postedAt: new Date(`${paidOn}T03:00:00Z`) } : {}),
      })
      .returning({ id: paymentVouchers.id });
    return row!.id;
  });
}

/** Phiếu chi đảo của `voucherId`, gốc sang `reversed`. */
export async function reverseRefund(companyId: string, voucherId: string, paidOn: string) {
  await withCompany(companyId, async () => {
    const [orig] = await getDb()
      .update(paymentVouchers)
      .set({ status: 'reversed' })
      .where(eq(paymentVouchers.id, voucherId))
      .returning({ orderId: paymentVouchers.orderId, amount: paymentVouchers.amount });
    await getDb()
      .insert(paymentVouchers)
      .values({
        companyId,
        number: docNumber('PC'),
        purpose: 'customer_refund',
        orderId: orig!.orderId,
        amount: money(-Number(orig!.amount)),
        paidOn,
        status: 'posted',
        createdBy: randomUUID(),
        reversalOfId: voucherId,
        reversalReason: 'Đảo thử',
      });
  });
}

/** Dòng đối soát `kind = order` của đơn sàn (một bảng kê riêng mỗi dòng). `fees`: các ô phí, số dương (T23). */
export async function settlementLine(
  companyId: string,
  orderId: string | null,
  options: { fees: Record<string, number>; shippingCost?: number; matchStatus?: 'matched' | 'discrepancy' | 'refund_tagged' },
) {
  await withCompany(companyId, async () => {
    const [statement] = await getDb()
      .insert(settlementStatements)
      .values({
        companyId,
        shopId: randomUUID(),
        externalStatementId: randomUUID(),
        statementTime: new Date(),
        settlementAmount: '0',
        paymentStatus: 'PAID',
      })
      .returning({ id: settlementStatements.id });
    const matchStatus = options.matchStatus ?? 'matched';
    await getDb()
      .insert(settlementLines)
      .values({
        companyId,
        statementId: statement!.id,
        kind: 'order',
        externalTransactionId: randomUUID(),
        orderId,
        revenue: '0',
        fees: options.fees,
        shippingCost: money(options.shippingCost ?? 0),
        settlement: '0',
        matchStatus,
        discrepancyReason: matchStatus === 'discrepancy' ? 'revenue_mismatch' : null,
        raw: {},
      });
  });
}

/** Giao dịch cổng của đơn (mặc định thành công, có phí). */
export async function gatewayTxn(
  companyId: string,
  orderId: string,
  options: { fee: number | null; occurredAt: string; status?: 'succeeded' | 'failed' },
) {
  await withCompany(companyId, () =>
    getDb()
      .insert(paymentTransactions)
      .values({
        companyId,
        orderId,
        gateway: 'momo',
        gatewayTxnId: randomUUID(),
        amount: '100000.00',
        fee: options.fee === null ? null : money(options.fee),
        source: 'webhook',
        status: options.status ?? 'succeeded',
        occurredAt: new Date(options.occurredAt),
      }),
  );
}

/** Gian hàng sàn của công ty với đúng `shopId` mà đơn sàn của `createOrder` mang (đơn sàn giả không có gian hàng thật). */
export async function shopFor(companyId: string, orderId: string, shopName: string) {
  const { rows } = await testPool().query<{ shop_id: string }>('select shop_id from "order".orders where id = $1', [orderId]);
  const shopId = rows[0]!.shop_id;
  await withCompany(companyId, () =>
    getDb().insert(shops).values({ id: shopId, companyId, platform: 'tiktok', externalShopId: randomUUID(), shopName }),
  );
  return shopId;
}
