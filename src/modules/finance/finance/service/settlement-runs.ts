// Kéo quyết toán của sàn và ghi số thật vào sổ (#117; Documents/21 §21.3; 25 §10.3, T4). Một lần chạy cho một gian
// hàng, từ mốc của lần `done` gần nhất tới bây giờ; gọi sàn ngoài giao dịch, ghi trong một giao dịch: mốc chỉ tiến
// khi cả lô ghi xong, chạy lại thì bỏ trùng theo mã giao dịch của sàn.
import { Decimal } from 'decimal.js';
import { withCompany, withSessionLock } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { findMarketplaceOrders } from '../../../order/index.ts';
import { vnDate } from '../domain/config-version.ts';
import { type PlatformPayout, type PlatformTxn, kindOfTransaction } from '../domain/settlement.ts';
import { existingTxnIds, insertEntries, openEstimates, platformBalanceOf } from '../repository/ledger.ts';
import type { ledgerEntries } from '../repository/schema.ts';
import {
  findRun,
  findRunningRun,
  finishRun,
  insertRun,
  lastDoneTo,
  listRuns,
  lockShopRuns,
  type SettlementRunRow,
} from '../repository/settlement-runs.ts';
import { currentThreshold, recomputeAfterSettlement } from './order-settlement-state.ts';
import type { FinanceContext } from './settlement-views.ts';
import { isUuid, notFound } from './views.ts';

const FIRST_RUN_DAYS = 30;

/** `SettlementRun` của §21.3. */
export function runView(r: SettlementRunRow) {
  return {
    id: r.id,
    shopId: r.shopId,
    source: r.source,
    fileId: r.fileId,
    from: r.periodFrom.toISOString(),
    to: r.periodTo.toISOString(),
    status: r.status,
    lineCount: r.lineCount,
    duplicates: r.duplicates,
    walletDiff: r.walletDiff === null ? null : Number(r.walletDiff),
    error: r.error,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
  };
}

export function listSettlementRuns(companyId: string, q: { shopId?: string; page: number; pageSize: number }) {
  return withCompany(companyId, async () => {
    const { rows, total } = await listRuns(q.shopId, { limit: q.pageSize, offset: (q.page - 1) * q.pageSize });
    return { items: rows.map(runView), total, page: q.page, pageSize: q.pageSize };
  });
}

/**
 * Mở một lần chạy `running` cho gian hàng; đang có lần chạy thì 409 `settlement_running`. Kỳ: từ mốc của lần `done`
 * gần nhất (lần đầu: 30 ngày trước) tới `now`. `accountId` null khi việc nền mở.
 */
export function openRun(ctx: FinanceContext, companyId: string, accountId: string | null, shopId: string, now = new Date()) {
  return withCompany(companyId, async () => {
    if (!ctx.settlementSource) throw new AppError(422, 'marketplace_unsupported', 'Chưa nối được sàn để kéo quyết toán');
    if (!isUuid(shopId) || (ctx.shopsOf && !(await ctx.shopsOf([shopId])).has(shopId))) throw notFound('gian hàng');
    await lockShopRuns(shopId);
    if (await findRunningRun(shopId)) throw new AppError(409, 'settlement_running', 'Gian hàng đang có một lần đối soát chạy');
    const from = (await lastDoneTo(shopId)) ?? new Date(now.getTime() - FIRST_RUN_DAYS * 86_400_000);
    return insertRun({ companyId, shopId, source: 'api', periodFrom: from, periodTo: now, createdBy: accountId });
  });
}

/** Chạy lần đã mở: gọi sàn, ghi sổ. Lỗi thì lần chạy `failed` kèm lý do, mốc không tiến. */
export async function processRun(ctx: FinanceContext, companyId: string, runId: string): Promise<SettlementRunRow> {
  const run = await withCompany(companyId, () => findRun(runId));
  if (!run) throw notFound('lần đối soát');
  if (run.status !== 'running') return run;
  try {
    const from = vnDate(run.periodFrom);
    const to = vnDate(run.periodTo);
    const txns = await ctx.settlementSource!.transactions(companyId, run.shopId, from, to);
    const payouts = await ctx.settlementSource!.payouts(companyId, run.shopId, from);
    return await withCompany(companyId, () => applyRun(run, txns, payouts));
  } catch (err) {
    const message = err instanceof AppError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
    logger.warn({ err, runId, shopId: run.shopId }, 'đối soát lỗi');
    return (await withCompany(companyId, () => finishRun(run.id, { status: 'failed', error: message.slice(0, 500) }))) ?? run;
  }
}

/** Mở và chạy luôn (POST trả 202 với lần chạy `running`; route chạy phần sau ở nền). */
export async function runSettlement(ctx: FinanceContext, companyId: string, accountId: string | null, shopId: string) {
  const run = await openRun(ctx, companyId, accountId, shopId);
  return processRun(ctx, companyId, run.id);
}

type EntryInsert = typeof ledgerEntries.$inferInsert;

/**
 * Ghi các khoản của lô (trong `withCompany`): mỗi khoản một dòng thực tế, thuế sàn khấu trừ thành dòng riêng; khoản đã
 * có trong sổ thì bỏ; dòng thực tế nối `replaces_entry_id` về dòng ước tính cùng đơn, cùng loại (một đối một). Rồi tính
 * lại trạng thái tiền của các đơn có khoản mới, so số dư ví với kỳ quyết toán mới nhất.
 */
async function applyRun(run: SettlementRunRow, txns: readonly PlatformTxn[], payouts: readonly PlatformPayout[]): Promise<SettlementRunRow> {
  await lockShopRuns(run.shopId);
  const parts = txns.flatMap((t) => {
    const main = { txnId: t.txnId, t, kind: kindOfTransaction(t.feeName, t.transactionType), amount: new Decimal(t.amount) };
    const wht = new Decimal(t.withholding || 0);
    return wht.isZero() ? [main] : [main, { txnId: `${t.txnId}:wht`, t, kind: 'withholding_tax' as const, amount: wht.abs().negated() }];
  });
  const seen = await existingTxnIds(parts.map((p) => p.txnId));
  const fresh = parts.filter((p) => !seen.has(p.txnId) && !p.amount.isZero());
  const duplicates = txns.filter((t) => seen.has(t.txnId)).length;

  const orders = await findMarketplaceOrders(
    run.shopId,
    fresh.flatMap((p) => (p.t.externalOrderId ? [p.t.externalOrderId] : [])),
  );
  const orderOf = (p: (typeof fresh)[number]) => (p.t.externalOrderId ? (orders.get(p.t.externalOrderId)?.id ?? null) : null);
  const queue = new Map<string, string[]>();
  for (const e of await openEstimates([...new Set(fresh.map(orderOf).filter((id): id is string => !!id))])) {
    const key = `${e.orderId}:${e.kind}`;
    queue.set(key, [...(queue.get(key) ?? []), e.id]);
  }

  const today = vnDate(run.periodTo);
  const rows: EntryInsert[] = fresh.map((p) => {
    const orderId = orderOf(p);
    const replaces = orderId ? (queue.get(`${orderId}:${p.kind}`)?.shift() ?? null) : null;
    return {
      companyId: run.companyId,
      kind: p.kind,
      amount: p.amount.toFixed(2),
      isEstimate: false,
      occurredOn: /^\d{4}-\d{2}-\d{2}$/.test(p.t.date) ? p.t.date : today,
      orderId,
      shopId: run.shopId,
      sourceType: 'settlement_batch',
      sourceId: run.id,
      externalTransactionId: p.txnId,
      replacesEntryId: replaces,
      reason: p.kind === 'adjustment' ? p.t.feeName || p.t.transactionType || 'Khoản sàn chưa phân loại' : null,
    };
  });
  await insertEntries(rows);

  const touched = [...new Set(rows.map((r) => r.orderId).filter((id): id is string => !!id))];
  await recomputeAfterSettlement(touched, run.shopId, await currentThreshold(run.periodTo));

  const latest = [...payouts].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  const walletDiff = latest ? new Decimal(latest.closingBalance).minus(await platformBalanceOf(run.shopId)).toFixed(2) : null;
  const done = await finishRun(run.id, { status: 'done', lineCount: rows.length, duplicates, walletDiff });
  return done ?? run;
}

const PULL_LOCK = 'finance.settlement_pull';

/** Việc nền: kéo quyết toán mọi gian hàng đang hoạt động; gian hàng đang có lần chạy thì bỏ qua lượt này. */
export async function pullAllShops(ctx: FinanceContext): Promise<number> {
  if (!ctx.settlementSource) return 0;
  let done = 0;
  for (const { companyId, shopId } of await ctx.settlementSource.shops()) {
    try {
      const run = await runSettlement(ctx, companyId, null, shopId);
      if (run.status === 'done') done++;
    } catch (err) {
      if (!(err instanceof AppError && err.code === 'settlement_running')) logger.error({ err, shopId }, 'kéo quyết toán lỗi');
    }
  }
  return done;
}

/** Một lượt kéo trên mọi bản sao worker: lượt khác đang chạy thì `busy`. */
export function pullAllShopsOnce(ctx: FinanceContext) {
  return withSessionLock(PULL_LOCK, () => pullAllShops(ctx));
}
