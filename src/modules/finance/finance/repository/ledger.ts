import { Decimal } from 'decimal.js';
import { and, count, desc, eq, exists, gte, inArray, isNotNull, isNull, lt, not, notInArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { currentCompanyId, getDb } from '../../../../shared/db/client.ts';
import { type LedgerKind, NON_CASH as NON_CASH_KINDS, NOT_SETTLEMENT_DIFF, OFF_PLATFORM } from '../domain/ledger.ts';
import { bankMatches, ledgerEntries, ledgerPackageLines, ledgerReplacements } from './schema.ts';

/**
 * Dòng sổ kèm quan hệ thay đọc từ `ledger_replacements` (#231): `replacesId` là dòng ước tính mà dòng thực tế này
 * thay, `replacedBy` là dòng thực tế đã thay dòng ước tính này.
 */
export type LedgerRow = typeof ledgerEntries.$inferSelect & { replacesId: string | null; replacedBy: string | null };

/** Nguồn của dòng sổ: chứng từ hay sự kiện sinh ra nó (cột `source_type`). */
export type LedgerSource = 'package' | 'package_return' | 'return_refund' | 'return_inspection' | 'supplier_return' | 'settlement_batch' | 'manual';

const NON_CASH = [...NON_CASH_KINDS];

/** Ghi lần lượt mọi dòng của một nguồn: khoá tới hết giao dịch để hai lần nhận cùng sự kiện không ghi trùng. */
export async function lockSource(type: LedgerSource, id: string): Promise<void> {
  const key = `finance.ledger:${currentCompanyId()}:${type}:${id}`;
  await getDb().execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

/**
 * Khoá các đơn tới hết giao dịch (#231): ghi dòng ước tính (`post`) và ghi lô quyết toán (`applyRun`) của cùng đơn chạy
 * lần lượt, để bên sau đọc được dòng bên trước đã commit và nối cặp (READ COMMITTED không thấy dòng chưa commit). Khoá
 * theo thứ tự id để hai lô nhiều đơn không khoá chéo nhau.
 */
export async function lockOrders(orderIds: readonly string[]): Promise<void> {
  for (const id of [...new Set(orderIds)].sort()) {
    const key = `finance.ledger_order:${currentCompanyId()}:${id}`;
    await getDb().execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }
}

/** Nguồn đã có dòng ước tính chưa (sự kiện phát lại, giao ít nhất một lần). */
export async function sourcePosted(type: LedgerSource, id: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ n: count() })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.sourceType, type), eq(ledgerEntries.sourceId, id)));
  return (row?.n ?? 0) > 0;
}

export async function insertEntries(rows: (typeof ledgerEntries.$inferInsert)[]): Promise<{ id: string; kind: LedgerKind; externalTransactionId: string | null }[]> {
  if (!rows.length) return [];
  return getDb()
    .insert(ledgerEntries)
    .values(rows)
    .returning({ id: ledgerEntries.id, kind: ledgerEntries.kind, externalTransactionId: ledgerEntries.externalTransactionId });
}

/**
 * Ghi quan hệ thay. Bên ghi giữ khoá đơn (`lockOrders`) nên không có giao dịch khác nối cùng dòng: trùng cặp là lỗi
 * logic, để lỗi unique nổi lên thay vì nuốt im.
 */
export async function insertReplacements(rows: { companyId: string; actualId: string; estimateId: string }[]): Promise<void> {
  if (rows.length) await getDb().insert(ledgerReplacements).values(rows);
}

/** Dòng hàng của kiện đã giao (lãi theo SKU); phát lại sự kiện không ghi trùng (unique kiện, số thứ tự dòng). */
export async function insertPackageLines(rows: (typeof ledgerPackageLines.$inferInsert)[]): Promise<void> {
  if (rows.length) await getDb().insert(ledgerPackageLines).values(rows).onConflictDoNothing();
}

/** Cặp thay của dòng đang đọc theo phía ước tính (`replacedBy`) và phía thực tế (`replacesId`), nối trái. */
const asEstimate = alias(ledgerReplacements, 'as_estimate');
const asActual = alias(ledgerReplacements, 'as_actual');
const pairOf = alias(ledgerReplacements, 'pair_of');
const groupMate = alias(ledgerEntries, 'group_mate');
const sameBatch = alias(ledgerEntries, 'same_batch');
const batchPair = alias(ledgerReplacements, 'batch_pair');

/**
 * Dòng không còn tính (#117, #231), đọc từ `ledger_replacements`, không so thời điểm ghi:
 * - dòng ước tính đã có cặp với một dòng thực tế;
 * - dòng tiền ước tính cùng nguồn (`source_type`, `source_id`: một kiện giao, một lần hoàn tiền…) với một dòng đã có
 *   cặp: lần quyết toán là số thật của cả khoản của nguồn đó, kể cả khoản sàn không thu (25 §10.1, T4: "Có quyết toán
 *   thì số thật thay số ước tính").
 * Giá vốn (`NON_CASH`) lấy từ thẻ kho, sàn không quyết toán, nên không bao giờ bị thay (25 §10.2).
 * Dựng lúc gọi: `getDb()` theo giao dịch của bên gọi. Tổng tiền ở sàn, `openEstimates`, lãi theo đơn, lãi theo danh
 * sách đơn, lãi theo SKU và chạy thử cấu hình dùng chung luật này.
 */
export const isReplaced = () =>
  and(
    notInArray(ledgerEntries.kind, NON_CASH),
    or(
      exists(getDb().select({ one: sql`1` }).from(pairOf).where(eq(pairOf.estimateId, ledgerEntries.id))),
      and(
        eq(ledgerEntries.isEstimate, true),
        isNotNull(ledgerEntries.sourceId),
        exists(
          getDb()
            .select({ one: sql`1` })
            .from(groupMate)
            .innerJoin(pairOf, eq(pairOf.estimateId, groupMate.id))
            .where(and(eq(groupMate.sourceType, ledgerEntries.sourceType), eq(groupMate.sourceId, ledgerEntries.sourceId))),
        ),
      ),
    ),
  )!;

const withPairs = { entry: ledgerEntries, replacesId: asActual.estimateId, replacedBy: asEstimate.actualId };
const toRow = (r: { entry: typeof ledgerEntries.$inferSelect; replacesId: string | null; replacedBy: string | null }): LedgerRow => ({
  ...r.entry,
  replacesId: r.replacesId,
  replacedBy: r.replacedBy,
});

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
    // Giá vốn không mang nhãn Ước tính (`isEstimateLine`, domain/ledger.ts): thuộc lọc thực tế, không thuộc lọc ước tính.
    f.filter === 'estimated' ? and(eq(ledgerEntries.isEstimate, true), notInArray(ledgerEntries.kind, NON_CASH), not(repl)) : undefined,
    f.filter === 'actual' ? or(eq(ledgerEntries.isEstimate, false), inArray(ledgerEntries.kind, NON_CASH)) : undefined,
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
    .select(withPairs)
    .from(ledgerEntries)
    .leftJoin(asEstimate, eq(asEstimate.estimateId, ledgerEntries.id))
    .leftJoin(asActual, eq(asActual.actualId, ledgerEntries.id))
    .where(where(f))
    .orderBy(desc(ledgerEntries.occurredOn), desc(ledgerEntries.createdAt), desc(ledgerEntries.id))
    .limit(page.limit)
    .offset(page.offset);
  const [total] = await getDb().select({ n: count() }).from(ledgerEntries).where(where(f));
  return { rows: rows.map(toRow), total: total?.n ?? 0 };
}

/** Mọi dòng của một đơn, cũ trước; `replaced` theo `isReplaced` (một luật cho SQL và lãi của đơn). */
export async function entriesOfOrder(orderId: string): Promise<(LedgerRow & { replaced: boolean })[]> {
  const rows = await getDb()
    .select({ ...withPairs, replaced: sql<boolean>`(${isReplaced()})` })
    .from(ledgerEntries)
    .leftJoin(asEstimate, eq(asEstimate.estimateId, ledgerEntries.id))
    .leftJoin(asActual, eq(asActual.actualId, ledgerEntries.id))
    .where(eq(ledgerEntries.orderId, orderId))
    .orderBy(ledgerEntries.occurredOn, ledgerEntries.createdAt, ledgerEntries.id);
  return rows.map((r) => ({ ...toRow(r), replaced: r.replaced }));
}

/**
 * Tổng tiền theo chỗ (25 §10.2, T3) trên dòng tiền mặt còn hiệu lực trong phạm vi lọc gian hàng: `receivable` là số
 * ước tính đang ở sàn chưa quyết toán, `platformBalance` là số sàn đã quyết toán (thực tế). Bỏ khoản ngoài sàn
 * (`OFF_PLATFORM`: trả NCC, NCC hoàn tiền, COD tự giao, chi vận hành) theo loại dòng, không theo gian hàng; rút tiền giữ
 * lại vì "Số dư ví sàn trong app = tổng đã quyết toán − tổng đã rút − khoản trừ của gian hàng" (25 §10.3).
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
        notInArray(ledgerEntries.kind, [...NON_CASH, ...OFF_PLATFORM]),
        shopId ? eq(ledgerEntries.shopId, shopId) : undefined,
        not(isReplaced()),
      ),
    );
  return row!;
}

// ── Đối soát (#117) ─────────────────────────────────────────────────────────────────────────────────────────────

/** Mã giao dịch sàn đã có trong sổ (chạy lại cùng kỳ thì bỏ qua). */
/** Mã giao dịch sàn đã có trong sổ của gian hàng: khoá chống trùng là (gian hàng, mã giao dịch) (25 §10.3, #250). */
export async function existingTxnIds(shopId: string, ids: readonly string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await getDb()
    .select({ id: ledgerEntries.externalTransactionId })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.shopId, shopId), inArray(ledgerEntries.externalTransactionId, [...ids])));
  return new Set(rows.map((r) => r.id!));
}

/**
 * Dòng tiền ước tính còn hiệu lực (chưa `isReplaced`) của các đơn, cũ trước: lần quyết toán nối dòng thực tế cùng đơn,
 * cùng loại về đây. Dòng cùng nguồn với dòng đã nối coi như đã thay nên không nhận thêm dòng thực tế, để dòng thực tế
 * của kiện giao sau nối về dòng ước tính của chính kiện đó.
 */
export interface OpenEstimate {
  id: string;
  orderId: string;
  kind: LedgerKind;
  sourceType: string | null;
  sourceId: string | null;
}

export async function openEstimates(orderIds: readonly string[]): Promise<OpenEstimate[]> {
  if (!orderIds.length) return [];
  const rows = await getDb()
    .select({
      id: ledgerEntries.id,
      orderId: ledgerEntries.orderId,
      kind: ledgerEntries.kind,
      sourceType: ledgerEntries.sourceType,
      sourceId: ledgerEntries.sourceId,
    })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.isEstimate, true), inArray(ledgerEntries.orderId, [...orderIds]), not(isReplaced())))
    .orderBy(ledgerEntries.createdAt, ledgerEntries.id);
  return rows.map((r) => ({ ...r, orderId: r.orderId! }));
}

/**
 * Dòng thực tế của đơn, cùng loại, chưa nối, để nối với dòng ước tính vừa ghi (sàn quyết toán trước khi app nhận sự
 * kiện: kiện giao sau, hoàn tiền, E139). Cũ trước.
 * - Không truyền `batch`: chỉ nhận dòng của lô chưa nối dòng nào cùng đơn, cùng loại. Sàn trả nhiều dòng cùng loại cho
 *   phần đã có ước tính (mỗi món một dòng doanh thu) thì các dòng dư thuộc phần đó, không nối nhầm sang kiện sau.
 * - Truyền `batch` (lô của dòng doanh thu vừa nối với kiện này): chỉ nhận dòng của lô đó (#231, loại khác doanh thu
 *   chỉ nối khi doanh thu cùng lô đã nối vào đúng kiện).
 */
export async function unpairedActual(
  orderId: string,
  kind: LedgerKind,
  batch?: { sourceType: string | null; sourceId: string | null },
): Promise<{ id: string; sourceType: string | null; sourceId: string | null } | undefined> {
  const [row] = await getDb()
    .select({ id: ledgerEntries.id, sourceType: ledgerEntries.sourceType, sourceId: ledgerEntries.sourceId })
    .from(ledgerEntries)
    .leftJoin(asActual, eq(asActual.actualId, ledgerEntries.id))
    .where(
      and(
        eq(ledgerEntries.orderId, orderId),
        eq(ledgerEntries.kind, kind),
        eq(ledgerEntries.isEstimate, false),
        isNull(asActual.id),
        batch
          ? and(
              batch.sourceType ? eq(ledgerEntries.sourceType, batch.sourceType) : isNull(ledgerEntries.sourceType),
              batch.sourceId ? eq(ledgerEntries.sourceId, batch.sourceId) : isNull(ledgerEntries.sourceId),
            )
          : not(
              exists(
                getDb()
                  .select({ one: sql`1` })
                  .from(sameBatch)
                  .innerJoin(batchPair, eq(batchPair.actualId, sameBatch.id))
                  .where(
                    and(
                      eq(sameBatch.sourceType, ledgerEntries.sourceType),
                      eq(sameBatch.sourceId, ledgerEntries.sourceId),
                      eq(sameBatch.orderId, ledgerEntries.orderId),
                      eq(sameBatch.kind, ledgerEntries.kind),
                    ),
                  ),
              ),
            ),
      ),
    )
    .orderBy(ledgerEntries.createdAt, ledgerEntries.id)
    .limit(1);
  return row;
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
    .where(and(inArray(ledgerEntries.orderId, [...orderIds]), notInArray(ledgerEntries.kind, [...NOT_SETTLEMENT_DIFF])))
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
    .select(withPairs)
    .from(ledgerEntries)
    .leftJoin(asEstimate, eq(asEstimate.estimateId, ledgerEntries.id))
    .leftJoin(asActual, eq(asActual.actualId, ledgerEntries.id))
    .where(eq(ledgerEntries.id, id));
  return row && toRow(row);
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
  return { rows: rows.map((r) => ({ ...r.entry, replacesId: null, replacedBy: null })), total: total?.n ?? 0 };
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

/**
 * Tổng thuế khấu trừ (`withholding_tax`) của từng đơn, tách ước tính và thực tế (số sàn trừ trong quyết toán), để
 * bật cờ Lệch thuế (E135, #250). Đơn đã có dòng quyết toán mà sàn không trừ thuế thì `actual` là 0 (mức 0 cũng là một
 * mức khác app); đơn chưa có dòng quyết toán nào thì `actual` null.
 */
export async function withholdingOf(orderIds: readonly string[]): Promise<Map<string, { estimated: string; actual: string | null }>> {
  const out = new Map<string, { estimated: string; actual: string | null }>();
  if (!orderIds.length) return out;
  const wht = sql`${ledgerEntries.kind} = 'withholding_tax'`;
  const rows = await getDb()
    .select({
      orderId: ledgerEntries.orderId,
      estimated: sql<string>`coalesce(sum(${ledgerEntries.amount}) filter (where ${wht} and ${ledgerEntries.isEstimate}), 0)`,
      actual: sql<string | null>`sum(${ledgerEntries.amount}) filter (where ${wht} and not ${ledgerEntries.isEstimate})`,
      settled: sql<boolean>`bool_or(${ledgerEntries.sourceType} = 'settlement_batch' and not ${ledgerEntries.isEstimate})`,
    })
    .from(ledgerEntries)
    .where(inArray(ledgerEntries.orderId, [...orderIds]))
    .groupBy(ledgerEntries.orderId);
  for (const r of rows) {
    const actual = r.actual ?? (r.settled ? '0' : null);
    if (actual !== null || !new Decimal(r.estimated).isZero()) out.set(r.orderId!, { estimated: r.estimated, actual });
  }
  return out;
}
