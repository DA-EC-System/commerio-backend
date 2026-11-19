// Dữ liệu tiền của gian hàng bị xoá (#398): đếm để chặn, xoá phần không phải tiền. Chạy trong `withCompany` của bên gọi.
import { and, count, eq, inArray, ne, or, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { getDb } from '../../../../shared/db/client.ts';
import {
  configVersions,
  ledgerEntries,
  ledgerPackageLines,
  orderSettlements,
  paymentVouchers,
  receipts,
  salesInvoices,
  settlementBatches,
  settlementStatements,
} from './schema.ts';

/** `shop_id` của gian hàng, hoặc `order_id` thuộc đơn của gian hàng. */
const ofShop = (shopCol: PgColumn, orderCol: PgColumn, shopId: string, orderIds: readonly string[]): SQL =>
  orderIds.length ? or(eq(shopCol, shopId), inArray(orderCol, [...orderIds]))! : eq(shopCol, shopId);

export interface FinanceRowCounts {
  ledgerEntries: number;
  ledgerPackageLines: number;
  settlementStatements: number;
  settlementBatches: number;
  orderSettlements: number;
  documents: number;
}

/** Đếm dòng tiền theo nhóm (đọc, không khoá). Đối soát theo đơn chỉ tính `status <> 'none'`. */
export async function countShopFinanceRows(shopId: string, orderIds: readonly string[]): Promise<FinanceRowCounts> {
  const db = getDb();
  const n = async (q: Promise<{ n: number }[]>) => (await q)[0]!.n;
  const byOrders = async (table: typeof salesInvoices | typeof receipts | typeof paymentVouchers) =>
    orderIds.length ? n(db.select({ n: count() }).from(table).where(inArray(table.orderId, [...orderIds]))) : 0;
  return {
    ledgerEntries: await n(
      db.select({ n: count() }).from(ledgerEntries).where(ofShop(ledgerEntries.shopId, ledgerEntries.orderId, shopId, orderIds)),
    ),
    ledgerPackageLines: await n(
      db
        .select({ n: count() })
        .from(ledgerPackageLines)
        .where(ofShop(ledgerPackageLines.shopId, ledgerPackageLines.orderId, shopId, orderIds)),
    ),
    settlementStatements: await n(db.select({ n: count() }).from(settlementStatements).where(eq(settlementStatements.shopId, shopId))),
    settlementBatches: await n(db.select({ n: count() }).from(settlementBatches).where(eq(settlementBatches.shopId, shopId))),
    orderSettlements: await n(
      db
        .select({ n: count() })
        .from(orderSettlements)
        .where(and(ofShop(orderSettlements.shopId, orderSettlements.orderId, shopId, orderIds), ne(orderSettlements.status, 'none'))),
    ),
    documents: (await byOrders(salesInvoices)) + (await byOrders(receipts)) + (await byOrders(paymentVouchers)),
  };
}

/**
 * Xoá đối soát theo đơn còn `none` (theo `shop_id` hoặc đơn) và mọi phiên bản cấu hình có `shop_id` của gian hàng (một
 * câu: `supersedes_id` trỏ bản cùng gian hàng nên nằm trong cùng tập).
 */
export async function deleteShopFinanceRows(shopId: string, orderIds: readonly string[]) {
  const db = getDb();
  const settlements = await db
    .delete(orderSettlements)
    .where(and(ofShop(orderSettlements.shopId, orderSettlements.orderId, shopId, orderIds), eq(orderSettlements.status, 'none')))
    .returning({ id: orderSettlements.orderId });
  const configs = await db.delete(configVersions).where(eq(configVersions.shopId, shopId)).returning({ id: configVersions.id });
  return { orderSettlements: settlements.length, configVersions: configs.length };
}
