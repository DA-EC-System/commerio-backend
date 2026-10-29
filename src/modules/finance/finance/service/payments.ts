// Trạng thái tiền của đơn và khớp sao kê cho người dùng (#117; Documents/21 §21.2, §21.3): danh sách, chi tiết, chốt
// lệch (người khác người soạn cấu hình phí; lệch vượt hạn mức tự chốt cần CEO duyệt trước), CEO duyệt, khớp ngân hàng.
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { assertTransition, getStatusHistory, recordTransition } from '../../../core/index.ts';
import { vnDate } from '../domain/config-version.ts';
import type { LedgerKind } from '../domain/ledger.ts';
import { needsCeoApproval, settlementMachine, type SettlementState, type Threshold } from '../domain/settlement.ts';
import { entriesOfOrder, entriesToMatch, findEntry, insertBankMatch } from '../repository/ledger.ts';
import {
  countByStatus,
  findOrderSettlement,
  listOrderSettlements,
  type OrderSettlementRow,
  updateOrderSettlement,
} from '../repository/order-settlements.ts';
import { getEffectiveConfig } from './config-versions.ts';
import { lineViews } from './ledger.ts';
import { currentThreshold, SETTLEMENT_ENTITY } from './order-settlement-state.ts';
import { isUuid, notFound, type Orders, ordersOf, userRef } from './views.ts';

export interface Caller {
  companyId: string;
  accountId: string;
  permissions: readonly string[];
  enabledModules: readonly string[];
}

const num = (v: string | null) => (v === null ? null : Number(v));
const conflict = (row: OrderSettlementRow) => new AppError(409, 'version_conflict', 'Trạng thái tiền của đơn đã đổi', { current: row.version });

/** Người soạn cấu hình phí đang áp cho gian hàng hôm nay: người chốt lệch phải khác (§21.2). */
async function feeAuthorOf(shopId: string | null, now: Date) {
  return shopId ? ((await getEffectiveConfig('fee', shopId, vnDate(now)))?.createdBy ?? null) : null;
}

type Names = Map<string, Promise<{ id: string; name: string } | null>>;

/** `OrderPayment` của §21.2. */
async function view(row: OrderSettlementRow, orders: Orders, t: Threshold, names: Names, now: Date) {
  const author = await feeAuthorOf(row.shopId, now);
  const pendingCeo = row.status === 'mismatch' && row.diff !== null && needsCeoApproval(row.diff, row.resolvedDiffBase, t) && !row.approvedBy;
  return {
    orderId: row.orderId,
    orderCode: orders.get(row.orderId)?.code ?? null,
    shopId: row.shopId,
    status: row.status,
    estimatedTotal: Number(row.estimatedTotal),
    settledTotal: num(row.settledTotal),
    diff: num(row.diff),
    threshold: t,
    needsCeoApproval: pendingCeo,
    ceoApproval: row.approvedBy ? { by: await userRef(row.approvedBy, names), at: row.updatedAt.toISOString() } : null,
    resolved:
      row.status === 'resolved' && row.resolvedBy
        ? { by: await userRef(row.resolvedBy, names), at: row.resolvedAt?.toISOString() ?? null, reason: row.resolvedReason }
        : null,
    feeConfigAuthor: await userRef(author, names),
    version: row.version,
  };
}

export function listPayments(companyId: string, q: { status?: SettlementState; shopId?: string; page: number; pageSize: number }, now = new Date()) {
  return withCompany(companyId, async () => {
    const { rows, total } = await listOrderSettlements(q, { limit: q.pageSize, offset: (q.page - 1) * q.pageSize });
    const orders = await ordersOf(rows.map((r) => r.orderId));
    const t = await currentThreshold(now);
    const names: Names = new Map();
    return {
      items: await Promise.all(rows.map((r) => view(r, orders, t, names, now))),
      total,
      page: q.page,
      pageSize: q.pageSize,
      counts: await countByStatus(q.shopId),
    };
  });
}

async function detail(row: OrderSettlementRow, canSeeCost: boolean, now: Date) {
  const orders = await ordersOf([row.orderId]);
  const lines = (await entriesOfOrder(row.orderId)).filter((l) => canSeeCost || (l.kind !== 'cogs' && l.kind !== 'cogs_reversal'));
  return {
    ...(await view(row, orders, await currentThreshold(now), new Map(), now)),
    statusHistory: await getStatusHistory(SETTLEMENT_ENTITY, row.orderId),
    lines: await lineViews(lines, orders),
  };
}

async function load(orderId: string, lock?: 'update') {
  const row = isUuid(orderId) ? await findOrderSettlement(orderId, lock) : undefined;
  if (!row) throw notFound('trạng thái tiền của đơn');
  return row;
}

export function getPayment(companyId: string, orderId: string, canSeeCost: boolean, now = new Date()) {
  return withCompany(companyId, async () => detail(await load(orderId), canSeeCost, now));
}

/**
 * Chốt lệch (`mismatch → resolved`): bắt buộc lý do; người chốt khác người soạn cấu hình phí của gian hàng (409
 * `second_person_required`); lệch vượt hạn mức tự chốt thì người không có `finance.settlement.approve` cần CEO duyệt
 * trước (409 `ceo_approval_required`), CEO tự chốt được. Lệch lúc chốt lưu làm mốc cho lần điều chỉnh sau.
 */
export function resolvePayment(caller: Caller, orderId: string, input: { version: number; reason: string }, canSeeCost: boolean, now = new Date()) {
  return withCompany(caller.companyId, async () => {
    const row = await load(orderId, 'update');
    if (row.version !== input.version) throw conflict(row);
    const reason = input.reason.trim();
    const { to } = assertTransition(settlementMachine, row.status, 'resolve', {
      actor: { accountId: caller.accountId, permissions: caller.permissions, enabledModules: caller.enabledModules },
      record: { createdBy: await feeAuthorOf(row.shopId, now) },
      reason,
    });
    const isCeo = caller.permissions.includes('finance.settlement.approve');
    if (!isCeo && !row.approvedBy && needsCeoApproval(row.diff ?? 0, row.resolvedDiffBase, await currentThreshold(now))) {
      throw new AppError(409, 'ceo_approval_required', 'Lệch vượt hạn mức tự chốt: cần CEO duyệt trước');
    }
    const updated = await updateOrderSettlement(orderId, row, {
      status: to,
      resolvedBy: caller.accountId,
      resolvedAt: now,
      resolvedReason: reason,
      resolvedDiffBase: row.diff ?? '0',
      // CEO tự chốt thì không cần (và không được, CHECK người duyệt khác người chốt) giữ lần duyệt của chính mình.
      ...(row.approvedBy === caller.accountId && { approvedBy: null }),
    });
    if (!updated) throw conflict(row);
    await recordTransition({ entityType: SETTLEMENT_ENTITY, entityId: orderId, from: row.status, to, action: 'resolve', actorId: caller.accountId, reason });
    return detail(updated, canSeeCost, now);
  });
}

/** CEO duyệt chốt lệch vượt hạn mức (§21.2): không đổi trạng thái, ghi người duyệt; người chốt sau đó phải khác. */
export function approvePayment(caller: Caller, orderId: string, input: { version: number }, canSeeCost: boolean, now = new Date()) {
  return withCompany(caller.companyId, async () => {
    const row = await load(orderId, 'update');
    if (row.version !== input.version) throw conflict(row);
    if (row.status !== 'mismatch') throw new AppError(409, 'invalid_transition', 'Chỉ duyệt đơn đang lệch', { current: row.status });
    if (!needsCeoApproval(row.diff ?? 0, row.resolvedDiffBase, await currentThreshold(now))) {
      throw new AppError(409, 'approval_not_needed', 'Lệch trong hạn mức tự chốt, không cần CEO duyệt');
    }
    const updated = await updateOrderSettlement(orderId, row, { approvedBy: caller.accountId });
    if (!updated) throw conflict(row);
    await recordTransition({ entityType: SETTLEMENT_ENTITY, entityId: orderId, from: row.status, to: row.status, action: 'ceo_approve', actorId: caller.accountId });
    return detail(updated, canSeeCost, now);
  });
}

/** Loại khoản cần khớp với sao kê ngân hàng (§21.3). */
export const BANK_KINDS: readonly LedgerKind[] = ['withdrawal', 'supplier_refund', 'lost_compensation'];

export function listBankMatching(companyId: string, q: { kind?: LedgerKind; matched?: boolean; page: number; pageSize: number }) {
  return withCompany(companyId, async () => {
    const kinds = q.kind ? [q.kind] : BANK_KINDS;
    const { rows, total } = await entriesToMatch(kinds, q.matched, { limit: q.pageSize, offset: (q.page - 1) * q.pageSize });
    return { items: await lineViews(rows), total, page: q.page, pageSize: q.pageSize };
  });
}

/** Khớp một dòng sổ với mã giao dịch ngân hàng; dòng đã khớp thì 409 `already_matched`. */
export function matchBank(caller: Caller, entryId: string, bankRef: string) {
  return withCompany(caller.companyId, async () => {
    const entry = isUuid(entryId) ? await findEntry(entryId) : undefined;
    if (!entry) throw notFound('dòng sổ');
    if (!BANK_KINDS.includes(entry.kind) || entry.isEstimate) {
      throw new AppError(422, 'not_bank_matchable', 'Chỉ khớp sao kê cho rút tiền, NCC hoàn tiền, bồi thường đã ghi thực tế');
    }
    const ref = bankRef.trim();
    const match = await insertBankMatch({ companyId: caller.companyId, entryId, bankRef: ref, matchedBy: caller.accountId });
    if (!match) throw new AppError(409, 'already_matched', 'Dòng này đã khớp sao kê');
    return (await lineViews([entry]))[0]!;
  });
}
