import { and, count, desc, eq, exists, gte, inArray, isNotNull, lt, not, notInArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { currentCompanyId, getDb } from '../../../../shared/db/client.ts';
import type { LedgerKind } from '../domain/ledger.ts';
import { ledgerEntries } from './schema.ts';

export type LedgerRow = typeof ledgerEntries.$inferSelect & { replacedBy: string | null };

/** Nguồn của dòng sổ: chứng từ hay sự kiện sinh ra nó (cột `source_type`). */
export type LedgerSource = 'package' | 'package_return' | 'return_refund' | 'return_inspection' | 'settlement_batch' | 'manual';

const NON_CASH: LedgerKind[] = ['cogs', 'cogs_reversal'];

/** Ghi lần lượt mọi dòng của một nguồn: khoá tới hết giao dịch để hai lần nhận cùng sự kiện không ghi trùng. */
export async function lockSource(type: LedgerSource, id: string): Promise<void> {
  const key = `finance.ledger:${currentCompanyId()}:${type}:${id}`;
  await getDb().execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

/** Nguồn đã có dòng ước tính chưa (sự kiện phát lại, giao ít nhất một lần). */
export async function sourcePosted(type: LedgerSource, id: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ n: count() })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.sourceType, type), eq(ledgerEntries.sourceId, id)));
  return (row?.n ?? 0) > 0;
}

export async function insertEntries(rows: (typeof ledgerEntries.$inferInsert)[]): Promise<void> {
  if (rows.length) await getDb().insert(ledgerEntries).values(rows);
}

const replacing = alias(ledgerEntries, 'replacing');
/** Dòng thực tế thay dòng đang đọc, nối trái; unique `replaces_entry_id` nên mỗi dòng tối đa một dòng thay. */
const replacer = alias(ledgerEntries, 'replacer');
/** Dòng đã có dòng thực tế trỏ `replaces_entry_id` về nó. Dựng lúc gọi: `getDb()` theo giao dịch của bên gọi. */
const isReplaced = () => exists(getDb().select({ one: sql`1` }).from(replacing).where(eq(replacing.replacesEntryId, ledgerEntries.id)));

export interface LedgerFilter {
  filter?: 'all' | 'estimated' | 'actual' | 'replaced';
  kind?: LedgerKind;
  shopId?: string;
  orderId?: string;
  /** `occurred_on` từ ngày này (gồm). */
  from?: string;
  /** `occurred_on` trước ngày này (không gồm). */
  to?: string;
  /** Bỏ dòng giá vốn (người xem không có `inventory.cost.view`). */
  hideCost?: boolean;
}

function where(f: LedgerFilter) {
  const repl = isReplaced();
  return and(
    f.filter === 'estimated' ? and(eq(ledgerEntries.isEstimate, true), not(repl)) : undefined,
    f.filter === 'actual' ? eq(ledgerEntries.isEstimate, false) : undefined,
    f.filter === 'replaced' ? repl : undefined,
    f.kind ? eq(ledgerEntries.kind, f.kind) : undefined,
    f.shopId ? eq(ledgerEntries.shopId, f.shopId) : undefined,
    f.orderId ? eq(ledgerEntries.orderId, f.orderId) : undefined,
    f.from ? gte(ledgerEntries.occurredOn, f.from) : undefined,
    f.to ? lt(ledgerEntries.occurredOn, f.to) : undefined,
    f.hideCost ? notInArray(ledgerEntries.kind, NON_CASH) : undefined,
  );
}

/** Một trang sổ, mới trước; kèm tổng số dòng khớp lọc. */
export async function findEntries(f: LedgerFilter, page: { limit: number; offset: number }): Promise<{ rows: LedgerRow[]; total: number }> {
  const rows = await getDb()
    .select({ entry: ledgerEntries, replacedBy: replacer.id })
    .from(ledgerEntries)
    .leftJoin(replacer, eq(replacer.replacesEntryId, ledgerEntries.id))
    .where(where(f))
    .orderBy(desc(ledgerEntries.occurredOn), desc(ledgerEntries.createdAt), desc(ledgerEntries.id))
    .limit(page.limit)
    .offset(page.offset);
  const [total] = await getDb().select({ n: count() }).from(ledgerEntries).where(where(f));
  return { rows: rows.map((r) => ({ ...r.entry, replacedBy: r.replacedBy })), total: total?.n ?? 0 };
}

/** Mọi dòng của một đơn, cũ trước. */
export async function entriesOfOrder(orderId: string): Promise<LedgerRow[]> {
  const rows = await getDb()
    .select({ entry: ledgerEntries, replacedBy: replacer.id })
    .from(ledgerEntries)
    .leftJoin(replacer, eq(replacer.replacesEntryId, ledgerEntries.id))
    .where(eq(ledgerEntries.orderId, orderId))
    .orderBy(ledgerEntries.occurredOn, ledgerEntries.createdAt, ledgerEntries.id);
  return rows.map((r) => ({ ...r.entry, replacedBy: r.replacedBy }));
}

/**
 * Tổng tiền theo chỗ (25 §10.2, T3) trên dòng tiền mặt còn hiệu lực trong phạm vi lọc gian hàng: `receivable` là số
 * ước tính đang ở sàn chưa quyết toán, `platformBalance` là số sàn đã quyết toán (thực tế).
 */
export async function ledgerTotals(shopId?: string): Promise<{ receivable: string; platformBalance: string }> {
  const [row] = await getDb()
    .select({
      receivable: sql<string>`coalesce(sum(${ledgerEntries.amount}) filter (where ${ledgerEntries.isEstimate}), 0)::text`,
      platformBalance: sql<string>`coalesce(sum(${ledgerEntries.amount}) filter (where not ${ledgerEntries.isEstimate}), 0)::text`,
    })
    .from(ledgerEntries)
    .where(
      and(
        notInArray(ledgerEntries.kind, NON_CASH),
        isNotNull(ledgerEntries.shopId),
        shopId ? eq(ledgerEntries.shopId, shopId) : undefined,
        not(isReplaced()),
      ),
    );
  return row!;
}

/** Doanh thu luỹ kế từ ngày `from` (dòng còn hiệu lực), cho cảnh báo mốc thuế. */
export async function revenueSince(from: string): Promise<string> {
  const [row] = await getDb()
    .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)::text` })
    .from(ledgerEntries)
    .where(and(inArray(ledgerEntries.kind, ['revenue']), gte(ledgerEntries.occurredOn, from), not(isReplaced())));
  return row!.total;
}
