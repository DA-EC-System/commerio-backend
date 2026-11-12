// Kéo quyết toán của sàn và ghi số thật vào sổ (#117; Documents/21 §21.3; 25 §10.3, T4). Một lần chạy cho một gian
// hàng, từ mốc của lần `done` gần nhất tới bây giờ; gọi sàn ngoài giao dịch, ghi trong một giao dịch: mốc chỉ tiến
// khi cả lô ghi xong, chạy lại thì bỏ trùng theo mã giao dịch của sàn. Phần gọi sàn và ghi sổ chạy bằng việc nền
// `finance.settlement_run` (#248, E142): có thử lại, tiến trình chết thì việc được nhận lại.
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { withCompany, withSessionLock } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { defineQueue, type JobAttempt, sendJob } from '../../../core/index.ts';
import { findMarketplaceOrders } from '../../../order/index.ts';
import { vnDate } from '../domain/config-version.ts';
import type { PlatformPayout, PlatformTxn } from '../domain/settlement.ts';
import { existingTxnIds, insertEntries, openEstimates, platformBalanceOf } from '../repository/ledger.ts';
import type { ledgerEntries } from '../repository/schema.ts';
import {
  findRun,
  findRunningRun,
  finishRun,
  insertRun,
  lastDoneTo,
  latestRun,
  latestWalletDiffs,
  listRuns,
  lockShopRuns,
  reopenRun,
  type SettlementRunRow,
} from '../repository/settlement-runs.ts';
import { currentThreshold, recomputeAfterSettlement } from './order-settlement-state.ts';
import type { FinanceContext } from './settlement-views.ts';
import { isUuid, notFound } from './views.ts';

const FIRST_RUN_DAYS = 30;

/** Một lần chạy một việc; thử 3 lần (lần sau cách 1, 2 phút), mỗi lần tối đa 10 phút gọi sàn và ghi sổ. */
export const settlementRunQueue = defineQueue(
  'finance.settlement_run',
  z.object({ companyId: z.uuid(), shopId: z.uuid(), runId: z.uuid() }),
  { attempts: 3, retryDelaySeconds: 60, expireInSeconds: 600 },
);

/**
 * Lần `running` không đổi gì quá lâu là tiến trình đã chết qua mọi lượt thử (3 × 10 phút cộng chờ thử lại, dưới
 * 40 phút): lần mở sau đánh nó `failed` thay vì 409 mãi (E142).
 */
export const STALE_RUN_MS = 60 * 60_000;

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
 * Mở một lần chạy `running` cho gian hàng và gửi việc chạy nó (cùng giao dịch: không mở được thì không có việc).
 * Đang có lần chạy thì 409 `settlement_running`, trừ lần đã đứng quá `STALE_RUN_MS` (đánh `failed`). Kỳ: từ mốc
 * của lần `done` gần nhất (lần đầu: 30 ngày trước) tới `now`. `accountId` null khi việc nền mở.
 */
export function openRun(ctx: FinanceContext, companyId: string, accountId: string | null, shopId: string, now = new Date()) {
  return withCompany(companyId, async () => {
    if (!ctx.settlementSource) throw new AppError(422, 'marketplace_unsupported', 'Chưa nối được sàn để kéo quyết toán');
    if (!isUuid(shopId) || (ctx.shopsOf && !(await ctx.shopsOf([shopId])).has(shopId))) throw notFound('gian hàng');
    await lockShopRuns(shopId);
    const running = await findRunningRun(shopId);
    if (running && now.getTime() - running.updatedAt.getTime() < STALE_RUN_MS) {
      throw new AppError(409, 'settlement_running', 'Gian hàng đang có một lần đối soát chạy');
    }
    if (running) await finishRun(running.id, { status: 'failed', error: 'Lần chạy dừng giữa chừng, đã quá thời gian chờ' });
    const from = (await lastDoneTo(shopId)) ?? new Date(now.getTime() - FIRST_RUN_DAYS * 86_400_000);
    const run = await insertRun({ companyId, shopId, source: 'api', periodFrom: from, periodTo: now, createdBy: accountId });
    await sendJob(settlementRunQueue, { companyId, shopId, runId: run.id });
    return run;
  });
}

/**
 * Lần cần chạy: `running`; hoặc `failed` khi Admin chạy lại việc lỗi, nếu vẫn là lần mới nhất của gian hàng và gian
 * hàng không có lần nào đang chạy (mở lại thành `running`). Lần khác thì trả nguyên, không chạy.
 */
function claimRun(companyId: string, runId: string) {
  return withCompany(companyId, async () => {
    const run = await findRun(runId);
    if (!run || run.status !== 'failed') return run;
    await lockShopRuns(run.shopId);
    if ((await findRunningRun(run.shopId)) || (await latestRun(run.shopId))?.id !== run.id) return run;
    return (await reopenRun(run.id)) ?? run;
  });
}

/**
 * Chạy lần đã mở: gọi sàn, ghi sổ. Lỗi ở lượt chưa phải cuối thì ném lại để việc nền thử lại, lần chạy giữ `running`;
 * lượt cuối (mặc định khi gọi thẳng) thì lần chạy `failed` kèm lý do. Mốc chỉ tiến khi lô ghi xong.
 */
export async function processRun(
  ctx: FinanceContext,
  companyId: string,
  runId: string,
  attempt: Pick<JobAttempt, 'lastAttempt'> = { lastAttempt: true },
): Promise<SettlementRunRow> {
  const run = await claimRun(companyId, runId);
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
    logger.warn({ err, runId, shopId: run.shopId, lastAttempt: attempt.lastAttempt }, 'đối soát lỗi');
    if (!attempt.lastAttempt) throw err;
    return (await withCompany(companyId, () => finishRun(run.id, { status: 'failed', error: message.slice(0, 500) }))) ?? run;
  }
}

/** Handler của `finance.settlement_run`: lượt cuối mà lần chạy `failed` thì ném, việc vào trang việc lỗi (§14.5). */
export async function runSettlementJob(
  ctx: FinanceContext,
  job: { companyId: string; runId: string },
  attempt: JobAttempt,
): Promise<void> {
  const run = await processRun(ctx, job.companyId, job.runId, attempt);
  if (run.status === 'failed') throw new Error(run.error ?? 'Đối soát lỗi');
}

/** Mở và chạy luôn trong tiến trình này (test, dựng tay); việc gửi kèm thấy lần chạy đã xong thì không làm gì. */
export async function runSettlement(ctx: FinanceContext, companyId: string, accountId: string | null, shopId: string) {
  const run = await openRun(ctx, companyId, accountId, shopId);
  return processRun(ctx, companyId, run.id);
}

type EntryInsert = typeof ledgerEntries.$inferInsert;

/** Lý do của khoản adapter chưa ánh xạ: tên và mã phí gốc của sàn (US-TI-06 dòng 2, #251). */
function unmappedReason(t: PlatformTxn): string {
  const name = t.feeName || t.transactionType || 'Khoản sàn chưa phân loại';
  return t.feeCode ? `${name} (mã ${t.feeCode})` : name;
}

/**
 * Ghi các khoản của lô (trong `withCompany`): mỗi khoản một dòng thực tế, thuế sàn khấu trừ thành dòng riêng; khoản đã
 * có trong sổ thì bỏ; dòng thực tế nối `replaces_entry_id` về dòng ước tính cùng đơn, cùng loại (một đối một). Rồi tính
 * lại trạng thái tiền của các đơn có khoản mới, so số dư ví với kỳ quyết toán mới nhất.
 */
async function applyRun(run: SettlementRunRow, txns: readonly PlatformTxn[], payouts: readonly PlatformPayout[]): Promise<SettlementRunRow> {
  await lockShopRuns(run.shopId);
  // Việc chờ trong hàng quá `STALE_RUN_MS` thì lần mở sau đã đánh lần này `failed`: đọc lại sau khoá, không còn
  // `running` thì không ghi dòng nào dưới lần đã đóng (review #273).
  const current = await findRun(run.id);
  if (!current || current.status !== 'running') return current ?? run;
  // Mã lặp ngay trong lô (lật trang lệch, hai mã chỉ khác khoảng trắng trước khi chuẩn hoá): giữ khoản đầu, đếm phần
  // còn lại vào `duplicates` như khoản đã có trong sổ (review #274).
  const inBatch = new Set<string>();
  const unique = txns.filter((t) => !inBatch.has(t.txnId) && inBatch.add(t.txnId));
  const parts = unique.flatMap((t) => {
    const main = { txnId: t.txnId, t, kind: t.kind ?? ('adjustment' as const), amount: new Decimal(t.amount) };
    const wht = new Decimal(t.withholding || 0);
    return wht.isZero() ? [main] : [main, { txnId: `${t.txnId}:wht`, t, kind: 'withholding_tax' as const, amount: wht.abs().negated() }];
  });
  const seen = await existingTxnIds(run.shopId, parts.map((p) => p.txnId));
  const fresh = parts.filter((p) => !seen.has(p.txnId) && !p.amount.isZero());
  const duplicates = txns.length - unique.length + unique.filter((t) => seen.has(t.txnId)).length;

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
      externalOrderId: p.t.externalOrderId,
      replacesEntryId: replaces,
      // Adapter chưa nhận ra loại khoản: ghi `adjustment` kèm tên phí gốc (#203)
      reason: p.t.kind === null && p.kind === 'adjustment' ? unmappedReason(p.t) : null,
    };
  });
  await insertEntries(rows);

  const touched = [...new Set(rows.map((r) => r.orderId).filter((id): id is string => !!id))];
  const cancelled = new Set([...orders.values()].filter((o) => o.status === 'cancelled').map((o) => o.id));
  await recomputeAfterSettlement(touched, run.shopId, await currentThreshold(run.periodTo), cancelled);

  const latest = [...payouts].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  const walletDiff = latest ? new Decimal(latest.closingBalance).minus(await platformBalanceOf(run.shopId)).toFixed(2) : null;
  const done = await finishRun(run.id, { status: 'done', lineCount: rows.length, duplicates, walletDiff });
  return done ?? run;
}

/**
 * Cổng cho channel (Documents/21 §11.3, #251): lệch ví của lần đối soát `done` gần nhất có số, theo gian hàng. Gian
 * hàng chưa có lần nào như vậy, hoặc id không thuộc công ty (RLS), thì không có trong Map. Gọi trong `withCompany`.
 */
export const walletDiffOf = (shopIds: readonly string[]): Promise<Map<string, string>> => latestWalletDiffs(shopIds);

const PULL_LOCK = 'finance.settlement_pull';

/**
 * Việc nền: mở một lần chạy cho mọi gian hàng đang hoạt động, phần gọi sàn chạy ở `finance.settlement_run`; gian
 * hàng đang có lần chạy thì bỏ qua lượt này. Trả số lần đã mở.
 */
export async function pullAllShops(ctx: FinanceContext): Promise<number> {
  if (!ctx.settlementSource) return 0;
  let opened = 0;
  for (const { companyId, shopId } of await ctx.settlementSource.shops()) {
    try {
      await openRun(ctx, companyId, null, shopId);
      opened++;
    } catch (err) {
      if (!(err instanceof AppError && err.code === 'settlement_running')) logger.error({ err, shopId }, 'kéo quyết toán lỗi');
    }
  }
  return opened;
}

/** Một lượt kéo trên mọi bản sao worker: lượt khác đang chạy thì `busy`. */
export function pullAllShopsOnce(ctx: FinanceContext) {
  return withSessionLock(PULL_LOCK, () => pullAllShops(ctx));
}
