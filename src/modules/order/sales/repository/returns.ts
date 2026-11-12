// Yêu cầu trả (Documents/21 §20). Chạy trong `withCompany` của bên gọi. Kiện ở bảng của fulfillment (cùng schema
// `order`) đọc bằng SQL thô, không import schema của module con khác.
import { and, count, desc, eq, ilike, inArray, or, type SQL, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import type { ReturnStatus } from '../domain/return.ts';
import { customers, orderLines, orders, returnRequestLines, returnRequests } from './schema.ts';

export type ReturnRow = typeof returnRequests.$inferSelect;
export type ReturnPatch = Partial<Omit<typeof returnRequests.$inferInsert, 'id' | 'companyId' | 'version'>>;

const containsPattern = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export interface ReturnFilter {
  status?: ReturnStatus | undefined;
  source?: 'marketplace' | 'manual' | undefined;
  orderId?: string | undefined;
  search?: string | undefined;
}

function where(f: ReturnFilter, withStatus = true): SQL | undefined {
  const pattern = f.search ? containsPattern(f.search) : undefined;
  return and(
    withStatus && f.status ? eq(returnRequests.status, f.status) : undefined,
    f.source ? eq(returnRequests.source, f.source) : undefined,
    f.orderId ? eq(returnRequests.orderId, f.orderId) : undefined,
    pattern ? or(ilike(returnRequests.code, pattern), ilike(orders.code, pattern), ilike(customers.name, pattern)) : undefined,
  );
}

export type ReturnListRow = ReturnRow & { orderCode: string; customerName: string | null; totalQty: number };

/** Một trang, mới trước, và số theo trạng thái (không theo `status` của bộ lọc) cho tab. */
export async function findReturnPage(f: ReturnFilter, page: number, pageSize: number) {
  const db = getDb();
  const totalQty = sql<number>`(select coalesce(sum(l.quantity), 0)::int from "order".return_request_lines l where l.request_id = ${returnRequests.id})`;
  const [rows, [total], byStatus] = await Promise.all([
    db
      .select({ r: returnRequests, orderCode: orders.code, customerName: customers.name, totalQty })
      .from(returnRequests)
      .innerJoin(orders, eq(orders.id, returnRequests.orderId))
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .where(where(f))
      .orderBy(desc(returnRequests.createdAt), desc(returnRequests.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ n: count() })
      .from(returnRequests)
      .innerJoin(orders, eq(orders.id, returnRequests.orderId))
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .where(where(f)),
    db
      .select({ status: returnRequests.status, n: count() })
      .from(returnRequests)
      .innerJoin(orders, eq(orders.id, returnRequests.orderId))
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .where(where(f, false))
      .groupBy(returnRequests.status),
  ]);
  return {
    items: rows.map((x): ReturnListRow => ({ ...x.r, orderCode: x.orderCode, customerName: x.customerName, totalQty: Number(x.totalQty) })),
    total: Number(total!.n),
    byStatus: new Map(byStatus.map((s) => [s.status, Number(s.n)])),
  };
}

export async function findReturn(id: string, opts: { lock?: boolean } = {}): Promise<ReturnRow | undefined> {
  const q = getDb().select().from(returnRequests).where(eq(returnRequests.id, id));
  const [row] = await (opts.lock ? q.for('update') : q);
  return row;
}

export async function findReturnOrder(orderId: string) {
  const [row] = await getDb()
    .select({ id: orders.id, code: orders.code, status: orders.status, customerName: customers.name, shopId: orders.shopId })
    .from(orders)
    .leftJoin(customers, eq(customers.id, orders.customerId))
    .where(eq(orders.id, orderId));
  return row;
}

export type ReturnLineRow = typeof returnRequestLines.$inferSelect & {
  sku: string | null;
  productName: string;
  attributesLabel: string | null;
  packageCode: string | null;
};

export async function findReturnLines(requestIds: readonly string[]): Promise<ReturnLineRow[]> {
  if (!requestIds.length) return [];
  const rows = await getDb()
    .select({
      l: returnRequestLines,
      sku: orderLines.sku,
      productName: orderLines.productName,
      attributesLabel: orderLines.attributesLabel,
      packageCode: sql<string | null>`(select p.code from "order".packages p where p.id = ${returnRequestLines.packageId})`,
    })
    .from(returnRequestLines)
    .innerJoin(orderLines, eq(orderLines.id, returnRequestLines.orderLineId))
    .where(inArray(returnRequestLines.requestId, [...requestIds]))
    .orderBy(returnRequestLines.createdAt, returnRequestLines.id);
  return rows.map((x) => ({ ...x.l, sku: x.sku, productName: x.productName, attributesLabel: x.attributesLabel, packageCode: x.packageCode }));
}

/** Ghi theo `version` và trạng thái đang có; false khi bản ghi vừa đổi (bên gọi đọc lại, 409). */
export async function updateReturnAt(id: string, version: number, from: ReturnStatus, patch: ReturnPatch): Promise<boolean> {
  const rows = await getDb()
    .update(returnRequests)
    .set({ ...patch, version: sql`${returnRequests.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(returnRequests.id, id), eq(returnRequests.version, version), eq(returnRequests.status, from)))
    .returning({ id: returnRequests.id });
  return rows.length > 0;
}

export async function updateReturnLine(id: string, patch: Partial<typeof returnRequestLines.$inferInsert>): Promise<void> {
  await getDb()
    .update(returnRequestLines)
    .set({ ...patch, version: sql`${returnRequestLines.version} + 1`, updatedAt: sql`now()` })
    .where(eq(returnRequestLines.id, id));
}

/** Yêu cầu khớp mã kho quét: mã yêu cầu, mã vận đơn chiều về, mã đơn hoặc mã đơn sàn (§20 `POST /returns/receive`). */
export async function findReturnsByCode(code: string): Promise<ReturnRow[]> {
  // `FOR UPDATE OF` không nhận tên bảng có schema (Drizzle ghi `"order"."return_requests"`): tìm id rồi khoá theo id.
  const found = await getDb()
    .select({ id: returnRequests.id })
    .from(returnRequests)
    .innerJoin(orders, eq(orders.id, returnRequests.orderId))
    .where(
      or(
        eq(returnRequests.code, code),
        eq(returnRequests.returnTrackingCode, code),
        eq(orders.code, code),
        eq(orders.externalOrderId, code),
      ),
    )
    .limit(20);
  if (!found.length) return [];
  return getDb()
    .select()
    .from(returnRequests)
    .where(inArray(returnRequests.id, found.map((f) => f.id)))
    .orderBy(desc(returnRequests.createdAt))
    .for('update');
}

/** Yêu cầu trả do Lazada (sàn) đẩy về, theo gian hàng và mã sàn, khoá để cập nhật. */
export async function findMarketplaceReturn(shopId: string, externalReturnId: string): Promise<ReturnRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(returnRequests)
    .where(and(eq(returnRequests.shopId, shopId), eq(returnRequests.externalReturnId, externalReturnId)))
    .for('update');
  return row;
}

export async function insertReturn(row: typeof returnRequests.$inferInsert): Promise<ReturnRow | undefined> {
  const [created] = await getDb().insert(returnRequests).values(row).onConflictDoNothing().returning();
  return created;
}

export async function insertReturnLines(rows: (typeof returnRequestLines.$inferInsert)[]): Promise<void> {
  if (rows.length) await getDb().insert(returnRequestLines).values(rows).onConflictDoNothing();
}

/** Yêu cầu theo phiếu kiểm hàng hoàn (nghe `inventory.return_inspected`). */
export async function findReturnByInspection(inspectionId: string): Promise<ReturnRow | undefined> {
  const [row] = await getDb().select().from(returnRequests).where(eq(returnRequests.inspectionId, inspectionId)).for('update');
  return row;
}

/** Dòng đơn theo mã món của sàn (gắn dòng yêu cầu trả từ sàn vào dòng đơn). */
export async function orderLinesByExternal(orderId: string, externalLineIds: readonly string[]) {
  if (!externalLineIds.length) return [];
  return getDb()
    .select({ id: orderLines.id, externalLineId: orderLines.externalLineId, variantId: orderLines.variantId, unitPrice: orderLines.unitPrice })
    .from(orderLines)
    .where(and(eq(orderLines.orderId, orderId), inArray(orderLines.externalLineId, [...externalLineIds])));
}
