import { and, count, desc, eq, exists, gte, inArray, isNotNull, isNull, lt, not, notInArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { currentCompanyId, getDb } from '../../../../shared/db/client.ts';
import type { LedgerKind } from '../domain/ledger.ts';
import { bankMatches, ledgerEntries } from './schema.ts';

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
const actualOfOrder = alias(ledgerEntries, 'actual_of_order');
/** Dòng thực tế thay dòng đang đọc, nối trái; unique `replaces_entry_id` nên mỗi dòng tối đa một dòng thay. */
const replacer = alias(ledgerEntries, 'replacer');
/**
 * Dòng không còn tính (#117): có dòng thực tế trỏ `replaces_entry_id` về nó, hoặc là dòng ước tính của đơn đã có số
 * thật từ quyết toán (số thật của cả đơn thay số ước tính, kể cả khoản sàn không thu). Dựng lúc gọi: `getDb()` theo
 * giao dịch của bên gọi.
 */
const isReplaced = () =>
  or(
    exists(getDb().select({ one: sql`1` }).from(replacing).where(eq(replacing.replacesEntryId, ledgerEntries.id))),
    and(
      eq(ledgerEntries.isEstimate, true),
      isNotNull(ledgerEntries.orderId),
      exists(
        getDb()
          .select({ one: sql`1` })
          .from(actualOfOrder)
          .where(and(eq(actualOfOrder.orderId, ledgerEntries.orderId), eq(actualOfOrder.isEstimate, false))),
      ),
    ),
  )!;

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
export async function ledgerTotals(shopId?: string): Promise<{ receivable: string; platformBalance: string; withdrawn: string }> {
  const [row] = await getDb()
    .select({
      receivable: sql<string>`coalesce(sum(${ledgerEntries.amount}) filter (where ${ledgerEntries.isEstimate}), 0)::text`,
      platformBalance: sql<string>`coalesce(sum(${ledgerEntries.amount}) filter (where not ${ledgerEntries.isEstimate}), 0)::text`,
      withdrawn: sql<string>`coalesce(-sum(${ledgerEntries.amount}) filter (where ${ledgerEntries.kind} = 'withdrawal'), 0)::text`,
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

// ── Đối soát (#117) ─────────────────────────────────────────────────────────────────────────────────────────────

/** Mã giao dịch sàn đã có trong sổ (chạy lại cùng kỳ thì bỏ qua). */
export async function existingTxnIds(ids: readonly string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await getDb()
    .select({ id: ledgerEntries.externalTransactionId })
    .from(ledgerEntries)
    .where(inArray(ledgerEntries.externalTransactionId, [...ids]));
  return new Set(rows.map((r) => r.id!));
}

/** Dòng ước tính chưa có dòng thực tế trỏ về, của các đơn: để nối dòng thực tế cùng loại về đúng dòng ước tính. */
export async function openEstimates(orderIds: readonly string[]): Promise<{ id: string; orderId: string; kind: LedgerKind }[]> {
  if (!orderIds.length) return [];
  const rows = await getDb()
    .select({ id: ledgerEntries.id, orderId: ledgerEntries.orderId, kind: ledgerEntries.kind })
    .from(ledgerEntries)
    .leftJoin(replacer, eq(replacer.replacesEntryId, ledgerEntries.id))
    .where(and(eq(ledgerEntries.isEstimate, true), inArray(ledgerEntries.orderId, [...orderIds]), isNull(replacer.id)))
    .orderBy(ledgerEntries.createdAt, ledgerEntries.id);
  return rows.map((r) => ({ id: r.id, orderId: r.orderId!, kind: r.kind }));
}

/** Tổng tiền mặt ước tính và thực tế theo đơn (không tính giá vốn, rút tiền), để so lệch quyết toán. */
export async function orderSums(orderIds: readonly string[]): Promise<Map<string, { estimated: string; actual: string }>> {
  if (!orderIds.length) return new Map();
  const rows = await getDb()
    .select({
      orderId: ledgerEntries.orderId,
      estimated: sql<string>`coalesce(sum(${ledgerEntries.amount}) filter (where ${ledgerEntries.isEstimate}), 0)::text`,
      actual: sql<string>`coalesce(sum(${ledgerEntries.amount}) filter (where not ${ledgerEntries.isEstimate}), 0)::text`,
    })
    .from(ledgerEntries)
    .where(and(inArray(ledgerEntries.orderId, [...orderIds]), notInArray(ledgerEntries.kind, [...NON_CASH, 'withdrawal'])))
    .groupBy(ledgerEntries.orderId);
  return new Map(rows.map((r) => [r.orderId!, { estimated: r.estimated, actual: r.actual }]));
}

/** Số dư ở sàn theo sổ của một gian hàng: mọi dòng thực tế tiền mặt, kể cả rút tiền (âm). */
export async function platformBalanceOf(shopId: string): Promise<string> {
  const [row] = await getDb()
    .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)::text` })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.shopId, shopId), eq(ledgerEntries.isEstimate, false), notInArray(ledgerEntries.kind, NON_CASH)));
  return row!.total;
}

export async function findEntry(id: string): Promise<LedgerRow | undefined> {
  const [row] = await getDb()
    .select({ entry: ledgerEntries, replacedBy: replacer.id })
    .from(ledgerEntries)
    .leftJoin(replacer, eq(replacer.replacesEntryId, ledgerEntries.id))
    .where(eq(ledgerEntries.id, id));
  return row && { ...row.entry, replacedBy: row.replacedBy };
}

/** Dòng các loại cần khớp sao kê (rút tiền, NCC hoàn, bồi thường), mới trước; `matched` lọc đã khớp hay chưa. */
export async function entriesToMatch(
  kinds: readonly LedgerKind[],
  matched: boolean | undefined,
  page: { limit: number; offset: number },
): Promise<{ rows: LedgerRow[]; total: number }> {
  const filter = and(
    inArray(ledgerEntries.kind, [...kinds]),
    eq(ledgerEntries.isEstimate, false),
    matched === undefined ? undefined : matched ? isNotNull(bankMatches.id) : isNull(bankMatches.id),
  );
  const rows = await getDb()
    .select({ entry: ledgerEntries })
    .from(ledgerEntries)
    .leftJoin(bankMatches, eq(bankMatches.entryId, ledgerEntries.id))
    .where(filter)
    .orderBy(desc(ledgerEntries.occurredOn), desc(ledgerEntries.id))
    .limit(page.limit)
    .offset(page.offset);
  const [total] = await getDb()
    .select({ n: count() })
    .from(ledgerEntries)
    .leftJoin(bankMatches, eq(bankMatches.entryId, ledgerEntries.id))
    .where(filter);
  return { rows: rows.map((r) => ({ ...r.entry, replacedBy: null })), total: total?.n ?? 0 };
}

export type BankMatchRow = typeof bankMatches.$inferSelect;

export async function bankMatchesOf(entryIds: readonly string[]): Promise<Map<string, BankMatchRow>> {
  if (!entryIds.length) return new Map();
  const rows = await getDb().select().from(bankMatches).where(inArray(bankMatches.entryId, [...entryIds]));
  return new Map(rows.map((r) => [r.entryId, r]));
}

/** Khớp sao kê; dòng đã khớp thì `undefined` (unique `bank_matches_entry_uq`). */
export async function insertBankMatch(values: typeof bankMatches.$inferInsert): Promise<BankMatchRow | undefined> {
  const [row] = await getDb().insert(bankMatches).values(values).onConflictDoNothing().returning();
  return row;
}

/** Doanh thu luỹ kế từ ngày `from` (dòng còn hiệu lực), cho cảnh báo mốc thuế. */
export async function revenueSince(from: string): Promise<string> {
  const [row] = await getDb()
    .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)::text` })
    .from(ledgerEntries)
    .where(and(inArray(ledgerEntries.kind, ['revenue']), gte(ledgerEntries.occurredOn, from), not(isReplaced())));
  return row!.total;
}
