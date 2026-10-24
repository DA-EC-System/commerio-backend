// Phiếu nhập, phiếu xuất và bộ đếm số phiếu. Chạy trong `withCompany` của bên gọi.
import { and, eq, ne, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import type { DocLineInput } from '../domain/stock.ts';
import { companyOfTransaction } from './levels.ts';
import { docCounters, stockIssueLines, stockIssues, stockReceiptLines, stockReceipts } from './schema.ts';

/** Số kế tiếp của loại phiếu trong công ty (plan #16 A5, đo E1): upsert khoá đúng một dòng, không trùng khi song song. */
export async function nextDocSeq(docType: 'receipt' | 'issue'): Promise<number> {
  const [row] = await getDb()
    .insert(docCounters)
    .values({ companyId: companyOfTransaction(), docType, nextNumber: 2 })
    .onConflictDoUpdate({
      target: [docCounters.companyId, docCounters.docType, docCounters.period],
      set: { nextNumber: sql`${docCounters.nextNumber} + 1` },
    })
    .returning({ n: sql<number>`${docCounters.nextNumber} - 1` });
  return Number(row!.n);
}

/** Phiếu xuất chưa huỷ của đơn (mỗi đơn tối đa một, 19-D35). */
export async function findOrderIssue(orderId: string) {
  const [row] = await getDb()
    .select({ id: stockIssues.id, number: stockIssues.number, status: stockIssues.status })
    .from(stockIssues)
    .where(and(eq(stockIssues.orderId, orderId), ne(stockIssues.status, 'cancelled')));
  return row ?? null;
}

/** Chèn phiếu xuất theo đơn đã ghi sổ; đơn đã có phiếu chưa huỷ thì không chèn, trả `null` (gọi đồng thời an toàn). */
export async function insertOrderIssue(input: { orderId: string; number: string; actorId: string | null }) {
  const [row] = await getDb()
    .insert(stockIssues)
    .values({
      companyId: companyOfTransaction(),
      number: input.number,
      kind: 'order',
      orderId: input.orderId,
      status: 'done',
      createdBy: input.actorId,
      postedBy: input.actorId,
      postedAt: new Date(),
    })
    .onConflictDoNothing({ target: stockIssues.orderId, where: sql`status <> 'cancelled'` })
    .returning({ id: stockIssues.id });
  return row?.id ?? null;
}

export async function issueLines(issueId: string) {
  return getDb()
    .select({ id: stockIssueLines.id, variantId: stockIssueLines.variantId, quantity: stockIssueLines.quantity, unitCost: stockIssueLines.unitCost })
    .from(stockIssueLines)
    .where(eq(stockIssueLines.issueId, issueId));
}

export async function insertIssueLines(issueId: string, lines: readonly { variantId: string; quantity: number }[]) {
  const companyId = companyOfTransaction();
  return getDb()
    .insert(stockIssueLines)
    .values(lines.map((l, i) => ({ companyId, issueId, variantId: l.variantId, quantity: l.quantity, createdAt: lineTime(Date.now(), i) })))
    .returning({ id: stockIssueLines.id, variantId: stockIssueLines.variantId, quantity: stockIssueLines.quantity });
}

/** Phiếu nhập hoàn chưa huỷ của đơn (mỗi đơn tối đa một, 19-D35). */
export async function findOrderReturn(orderId: string) {
  const [row] = await getDb()
    .select({ id: stockReceipts.id, number: stockReceipts.number })
    .from(stockReceipts)
    .where(and(eq(stockReceipts.orderId, orderId), eq(stockReceipts.kind, 'delivery_return'), ne(stockReceipts.status, 'cancelled')));
  return row ?? null;
}

/** Chèn phiếu nhập hoàn đã ghi sổ; đơn đã có phiếu chưa huỷ thì `null`. */
export async function insertReturnReceipt(input: { orderId: string; number: string; note: string | null; actorId: string | null }) {
  const [row] = await getDb()
    .insert(stockReceipts)
    .values({
      companyId: companyOfTransaction(),
      number: input.number,
      kind: 'delivery_return',
      orderId: input.orderId,
      status: 'done',
      note: input.note,
      createdBy: input.actorId,
      postedBy: input.actorId,
      postedAt: new Date(),
    })
    .onConflictDoNothing({ target: stockReceipts.orderId, where: sql`kind = 'delivery_return' and status <> 'cancelled'` })
    .returning({ id: stockReceipts.id });
  return row?.id ?? null;
}

export async function insertReceiptLines(receiptId: string, lines: readonly { variantId: string; quantity: number }[]) {
  const companyId = companyOfTransaction();
  return getDb()
    .insert(stockReceiptLines)
    .values(lines.map((l, i) => ({ companyId, receiptId, variantId: l.variantId, quantity: l.quantity, createdAt: lineTime(Date.now(), i) })))
    .returning({ id: stockReceiptLines.id, variantId: stockReceiptLines.variantId, quantity: stockReceiptLines.quantity });
}

// ---------- Phiếu lập tay qua API (lát 3) ----------

export type DocType = 'receipt' | 'issue';

export type DocRow = {
  id: string;
  type: DocType;
  number: string;
  kind: 'purchase' | 'manual' | 'delivery_return' | 'order';
  status: 'draft' | 'done' | 'cancelled';
  note: string | null;
  reference: string | null;
  createdBy: string | null;
  createdAt: Date;
  postedBy: string | null;
  postedAt: Date | null;
  version: number;
};

const tables = { receipt: stockReceipts, issue: stockIssues } as const;
const lineTables = { receipt: stockReceiptLines, issue: stockIssueLines } as const;

function docColumns(type: DocType) {
  const t = tables[type];
  return {
    id: t.id,
    number: t.number,
    kind: t.kind,
    status: t.status,
    note: t.note,
    reference: t.reference,
    createdBy: t.createdBy,
    createdAt: t.createdAt,
    postedBy: t.postedBy,
    postedAt: t.postedAt,
    version: t.version,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Phiếu theo id ở cả hai bảng; id không phải uuid thì như không có (V6). `forUpdate` khoá dòng phiếu (bước đầu của
 * thứ tự khoá, plan A6, A8).
 */
export async function findDoc(id: string, forUpdate = false): Promise<DocRow | null> {
  if (!UUID.test(id)) return null;
  for (const type of ['receipt', 'issue'] as const) {
    const t = tables[type];
    const query = getDb().select(docColumns(type)).from(t).where(eq(t.id, id));
    const [row] = forUpdate ? await query.for('update') : await query;
    if (row) return { ...row, type } as DocRow;
  }
  return null;
}

export async function docLines(type: DocType, docId: string) {
  const l = lineTables[type];
  const parent = type === 'receipt' ? stockReceiptLines.receiptId : stockIssueLines.issueId;
  return getDb()
    .select({ id: l.id, variantId: l.variantId, quantity: l.quantity, unitCost: l.unitCost })
    .from(l)
    .where(eq(parent, docId))
    .orderBy(l.createdAt, l.id);
}

/** `created_at` tăng 1 ms theo chỉ số dòng để đọc ra đúng thứ tự lúc lập (lỗi `lines.<i>` đúng ô). */
const lineTime = (base: number, i: number) => new Date(base + i);

async function insertLines(type: DocType, docId: string, lines: readonly DocLineInput[]) {
  const companyId = companyOfTransaction();
  const base = Date.now();
  if (type === 'receipt') {
    await getDb()
      .insert(stockReceiptLines)
      .values(
        lines.map((l, i) => ({
          companyId,
          receiptId: docId,
          variantId: l.variantId,
          quantity: l.quantity,
          unitCost: String(l.unitCost),
          createdAt: lineTime(base, i),
        })),
      );
  } else {
    await getDb()
      .insert(stockIssueLines)
      .values(lines.map((l, i) => ({ companyId, issueId: docId, variantId: l.variantId, quantity: l.quantity, createdAt: lineTime(base, i) })));
  }
}

/** Phiếu nháp lập tay kèm dòng (giá phiếu xuất để trống tới khi ghi sổ, K2). */
export async function insertManualDoc(input: { type: DocType; number: string; note: string; createdBy: string; lines: readonly DocLineInput[] }) {
  const t = tables[input.type];
  const [row] = await getDb()
    .insert(t)
    .values({ companyId: companyOfTransaction(), number: input.number, kind: 'manual', note: input.note, createdBy: input.createdBy })
    .returning({ id: t.id });
  await insertLines(input.type, row!.id, input.lines);
  return row!.id;
}

/** Thay ghi chú và toàn bộ dòng của phiếu nháp, tăng `version`. */
export async function replaceDraft(type: DocType, id: string, note: string, lines: readonly DocLineInput[]) {
  const l = lineTables[type];
  const parent = type === 'receipt' ? stockReceiptLines.receiptId : stockIssueLines.issueId;
  await getDb().delete(l).where(eq(parent, id));
  await insertLines(type, id, lines);
  await bumpDoc(type, id, { note });
}

/** Đổi trạng thái/ghi chú phiếu (đã khoá bằng `findDoc(id, true)`), tăng `version`. */
export async function bumpDoc(
  type: DocType,
  id: string,
  set: { note?: string; status?: 'done' | 'cancelled'; postedBy?: string; postedAt?: Date },
) {
  const t = tables[type];
  await getDb()
    .update(t)
    .set({ ...set, updatedAt: new Date(), version: sql`${t.version} + 1` })
    .where(eq(t.id, id));
}

export type DocListRow = DocRow & { lineCount: number; totalQty: number };

type DocFilter = { type?: DocType | undefined; status?: string | undefined; search?: string | undefined };

/** Phiếu nhập và xuất gộp (`UNION ALL`, cùng schema inventory) đã lọc. */
function filteredDocs(filter: DocFilter) {
  const like = filter.search ? `%${filter.search.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c)}%` : null;
  return sql`(
    select * from (
      select r.id, 'receipt' as type, r.number, r.kind::text as kind, r.status::text as status, r.note, r.reference,
        r.created_by as "createdBy", r.created_at as "createdAt", r.posted_by as "postedBy", r.posted_at as "postedAt",
        r.version,
        (select count(*)::int from inventory.stock_receipt_lines l where l.receipt_id = r.id) as "lineCount",
        (select coalesce(sum(l.quantity), 0)::int from inventory.stock_receipt_lines l where l.receipt_id = r.id) as "totalQty"
      from inventory.stock_receipts r
      union all
      select i.id, 'issue', i.number, i.kind::text, i.status::text, i.note, i.reference,
        i.created_by, i.created_at, i.posted_by, i.posted_at, i.version,
        (select count(*)::int from inventory.stock_issue_lines l where l.issue_id = i.id),
        (select coalesce(sum(l.quantity), 0)::int from inventory.stock_issue_lines l where l.issue_id = i.id)
      from inventory.stock_issues i
    ) u
    where (${filter.type ?? null}::text is null or u.type = ${filter.type ?? null})
      and (${filter.status ?? null}::text is null or u.status = ${filter.status ?? null})
      and (${like}::text is null or lower(u.number) like ${like} or lower(coalesce(u.note, '')) like ${like}
           or lower(coalesce(u.reference, '')) like ${like})
  ) d`;
}

/** Một trang phiếu, mới nhất trước, và tổng số phiếu khớp. */
export async function listDocs(filter: DocFilter & { limit: number; offset: number }) {
  const page = await getDb().execute<DocListRow>(
    sql`select * from ${filteredDocs(filter)} order by d."createdAt" desc, d.number desc limit ${filter.limit} offset ${filter.offset}`,
  );
  const count = await getDb().execute<{ n: number }>(sql`select count(*)::int as n from ${filteredDocs(filter)}`);
  return { rows: page.rows, total: count.rows[0]!.n };
}
