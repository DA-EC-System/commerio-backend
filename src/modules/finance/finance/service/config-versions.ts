// Phiên bản cấu hình tiền (#118, Documents/21 §21.4): soạn, chạy thử, gửi duyệt, duyệt (người thứ hai), tự áp dụng
// đúng ngày bằng việc nền, hết hiệu lực khi bản sau cùng ô có hiệu lực. Sổ tiền (#116) chọn phiên bản theo ngày kiện
// giao bằng `getEffectiveConfig`. Ghi điều chỉnh hồi tố cho bản sửa lỗi cần sổ tiền: làm ở #116.
import { Decimal } from 'decimal.js';
import { withCompany, withSessionLock } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { assertTransition, canSelfApprove, getStatusHistory, publishEvent, recordTransition } from '../../../core/index.ts';
import {
  addDays,
  type ConfigAction,
  type ConfigKind,
  type ConfigPayload,
  configMachine,
  type ConfigStatus,
  feePctOf,
  parsePayload,
  pickEffective,
  placeInTimeline,
  taxPctOf,
  vnDate,
} from '../domain/config-version.ts';
import {
  type ConfigFilter,
  type ConfigRow,
  findCell,
  findConfig,
  findConfigs,
  findDueScheduledAnyCompany,
  insertConfig,
  lockCell,
  setEffectiveTo,
  sumLedgerSince,
  updateConfig,
} from '../repository/config-versions.ts';
import type { FinanceContext } from './settlement-views.ts';
import { isUuid, notFound, type Page, paginate, userRef } from './views.ts';

const ENTITY = 'config_versions';
const LIVE: readonly ConfigStatus[] = ['scheduled', 'active'];

export interface Caller {
  companyId: string;
  accountId: string;
  permissions: readonly string[];
  enabledModules: readonly string[];
}

export interface ConfigInput {
  kind: ConfigKind;
  shopId?: string;
  payload: unknown;
  effectiveFrom: string;
  supersedesId?: string;
  isCorrection?: boolean;
  retroactiveFrom?: string;
}

const invalid = (errors: Record<string, string>) => new AppError(422, 'validation_failed', 'Dữ liệu gửi lên không hợp lệ', { errors });
const conflict = (row: ConfigRow) => new AppError(409, 'version_conflict', 'Phiên bản cấu hình đã được người khác sửa', { current: row.version });
const overlap = () => new AppError(409, 'config_overlap', 'Đã có phiên bản cùng gian hàng, cùng loại, cùng ngày hiệu lực');

function checkPayload(kind: ConfigKind, payload: unknown): ConfigPayload {
  const parsed = parsePayload(kind, payload);
  if (parsed.success) return parsed.data;
  const errors: Record<string, string> = {};
  for (const issue of parsed.error.issues) errors[['payload', ...issue.path.map(String)].join('.')] ??= issue.message;
  throw invalid(errors);
}

/** `FinanceConfig` của §21.4. `statusHistory` chỉ có ở bản chi tiết (R7). */
async function view(row: ConfigRow, names = new Map<string, Promise<{ id: string; name: string } | null>>()) {
  return {
    id: row.id,
    kind: row.kind,
    shopId: row.shopId,
    payload: row.payload as ConfigPayload,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    supersedesId: row.supersedesId,
    isCorrection: row.isCorrection,
    retroactiveFrom: row.retroactiveFrom,
    status: row.status,
    statusReason: row.statusReason,
    createdBy: await userRef(row.createdBy, names),
    approvedBy: await userRef(row.approvedBy, names),
    selfApproved: row.selfApproved,
    dryRun: (row.dryRunResult as DryRun | null) ?? null,
    createdAt: row.createdAt.toISOString(),
    version: row.version,
  };
}

async function detail(row: ConfigRow) {
  return { ...(await view(row)), statusHistory: await getStatusHistory(ENTITY, row.id) };
}

async function load(id: string, lock?: 'update'): Promise<ConfigRow> {
  const row = isUuid(id) ? await findConfig(id, lock) : undefined;
  if (!row) throw notFound('phiên bản cấu hình');
  return row;
}

export function listConfigs(companyId: string, q: ConfigFilter & Page) {
  return withCompany(companyId, async () => {
    const { slice, ...pageInfo } = paginate(await findConfigs(q), q, () => []);
    const names = new Map();
    return { items: await Promise.all(slice.map((r) => view(r, names))), ...pageInfo };
  });
}

export function getConfig(companyId: string, id: string) {
  return withCompany(companyId, async () => detail(await load(id)));
}

export function createConfig(caller: Caller, input: ConfigInput) {
  return withCompany(caller.companyId, async () => {
    const errors: Record<string, string> = {};
    if ((input.kind === 'fee') !== !!input.shopId) errors.shopId = input.kind === 'fee' ? 'Phí sàn cần gian hàng' : 'Chỉ phí sàn mới gắn gian hàng';
    if (input.retroactiveFrom && !input.isCorrection) errors.retroactiveFrom = 'Chỉ bản sửa lỗi mới ghi hồi tố';
    if (input.isCorrection && !input.supersedesId) errors.supersedesId = 'Bản sửa lỗi cần bản bị sửa';
    if (Object.keys(errors).length) throw invalid(errors);
    const payload = checkPayload(input.kind, input.payload);
    if (input.supersedesId) {
      const target = isUuid(input.supersedesId) ? await findConfig(input.supersedesId) : undefined;
      if (!target || target.kind !== input.kind || target.shopId !== (input.shopId ?? null))
        throw invalid({ supersedesId: 'Bản bị sửa không có hoặc khác loại, khác gian hàng' });
    }
    const row = await insertConfig({
      companyId: caller.companyId,
      kind: input.kind,
      shopId: input.shopId ?? null,
      payload,
      effectiveFrom: input.effectiveFrom,
      supersedesId: input.supersedesId ?? null,
      isCorrection: input.isCorrection ?? false,
      retroactiveFrom: input.retroactiveFrom ?? null,
      createdBy: caller.accountId,
    });
    await recordTransition({ entityType: ENTITY, entityId: row.id, from: null, to: 'draft', action: 'create', actorId: caller.accountId });
    return detail(row);
  });
}

/** Sửa nội dung, ngày hiệu lực; chỉ bản nháp. Sửa thì kết quả chạy thử cũ hết giá trị. */
export function updateDraft(caller: Caller, id: string, input: { version: number; payload: unknown; effectiveFrom: string }) {
  return withCompany(caller.companyId, async () => {
    const row = await load(id, 'update');
    if (row.version !== input.version) throw conflict(row);
    if (row.status !== 'draft') throw new AppError(409, 'invalid_transition', 'Chỉ sửa được phiên bản nháp', { current: row.status });
    const payload = checkPayload(row.kind, input.payload);
    const updated = await updateConfig(row.id, row, { payload, effectiveFrom: input.effectiveFrom, dryRunResult: null });
    if (!updated) throw conflict(row);
    return detail(updated);
  });
}

export interface DryRun {
  at: string;
  rows: {
    shopId: string;
    shopName: string | null;
    feePct: number | null;
    taxPct: number | null;
    /** Cần giá theo sàn của C2 (#104): null tới khi có. */
    listingsRepriced: number | null;
    belowFloor: number | null;
  }[];
  profit30: { now: number; next: number };
}

/**
 * Chạy thử, không ghi sổ: lãi 30 ngày gần nhất theo sổ tiền (`now`) và lãi nếu áp phiên bản này (`next`). Phí sàn,
 * thuế đổi bao nhiêu phần trăm thì lãi đổi bấy nhiêu phần trăm doanh thu. Loại khác không đổi lãi trực tiếp.
 */
async function computeDryRun(ctx: FinanceContext, row: ConfigRow, now: Date): Promise<DryRun> {
  const today = vnDate(now);
  const { total, revenue } = await sumLedgerSince(addDays(today, -30), row.kind === 'fee' ? row.shopId! : undefined);
  const base = new Decimal(total);
  let next = base;
  let feePct: number | null = null;
  let taxPct: number | null = null;
  if (row.kind === 'fee' || row.kind === 'tax_rules') {
    const current = await effectiveIn(row.kind, row.shopId, today);
    if (row.kind === 'fee') {
      feePct = feePctOf(row.payload as ConfigPayload<'fee'>);
      const was = current ? feePctOf(current.payload as ConfigPayload<'fee'>) : 0;
      next = base.minus(new Decimal(revenue).times(feePct - was).div(100));
    } else {
      taxPct = taxPctOf(row.payload as ConfigPayload<'tax_rules'>);
      const was = current ? taxPctOf(current.payload as ConfigPayload<'tax_rules'>) : 0;
      next = base.minus(new Decimal(revenue).times(taxPct - was).div(100));
    }
  }
  const rows: DryRun['rows'] = [];
  if (row.shopId) {
    const shop = ctx.shopsOf ? (await ctx.shopsOf([row.shopId])).get(row.shopId) : undefined;
    rows.push({ shopId: row.shopId, shopName: shop?.shopName ?? null, feePct, taxPct, listingsRepriced: null, belowFloor: null });
  }
  return { at: now.toISOString(), rows, profit30: { now: base.round().toNumber(), next: next.round().toNumber() } };
}

export function dryRunConfig(ctx: FinanceContext, caller: Caller, id: string, version: number, now = new Date()) {
  return withCompany(caller.companyId, async () => {
    const row = await load(id, 'update');
    if (row.version !== version) throw conflict(row);
    if (row.status !== 'draft') throw new AppError(409, 'invalid_transition', 'Chỉ chạy thử phiên bản nháp', { current: row.status });
    const updated = await updateConfig(row.id, row, { dryRunResult: await computeDryRun(ctx, row, now) });
    if (!updated) throw conflict(row);
    return detail(updated);
  });
}

/** Bản đang áp cho một ngày trong ô (trong `withCompany` của bên gọi). */
async function effectiveIn(kind: ConfigKind, shopId: string | null, day: string): Promise<ConfigRow | undefined> {
  return pickEffective(await findCell(kind, shopId, ['active', 'expired']), day);
}

/**
 * Phiên bản áp cho một ngày (sổ tiền #116 chọn theo ngày kiện giao; mỗi dòng sổ lưu `id` đã dùng). Gọi trong
 * `withCompany` của bên gọi. Không có bản nào thì `undefined`.
 */
export async function getEffectiveConfig<K extends ConfigKind>(
  kind: K,
  shopId: string | null,
  day: string,
): Promise<{ id: string; payload: ConfigPayload<K>; createdBy: string | null } | undefined> {
  const row = await effectiveIn(kind, shopId, day);
  return row && { id: row.id, payload: row.payload as ConfigPayload<K>, createdBy: row.createdBy };
}

/** Thao tác người dùng theo máy trạng thái (§21.4). Duyệt bản đã tới ngày thì áp dụng ngay. */
export function actOnConfig(caller: Caller, id: string, action: ConfigAction, input: { version: number; reason?: string }, now = new Date()) {
  return withCompany(caller.companyId, async () => {
    const row = await load(id);
    await lockCell(row.kind, row.shopId);
    const locked = await load(id, 'update');
    if (locked.version !== input.version) throw conflict(locked);
    const today = vnDate(now);
    const { to, selfApproved } = assertTransition(configMachine, locked.status, action, {
      actor: { accountId: caller.accountId, permissions: caller.permissions, enabledModules: caller.enabledModules },
      record: { createdBy: locked.createdBy, effectiveFrom: locked.effectiveFrom, today },
      reason: input.reason ?? null,
      canSelfApprove: action === 'approve' ? await canSelfApprove(caller.accountId) : false,
      view: await view(locked),
    });
    if (action === 'submit' && !locked.dryRunResult)
      throw new AppError(422, 'dry_run_required', 'Cần chạy thử trước khi gửi duyệt');

    let effectiveTo: string | null = null;
    if (action === 'submit' || action === 'approve') {
      const placed = placeInTimeline(await findCell(locked.kind, locked.shopId, LIVE), {
        effectiveFrom: locked.effectiveFrom!,
        supersedesId: locked.supersedesId,
      });
      if (placed.overlap) throw overlap();
      if (action === 'approve') {
        effectiveTo = placed.effectiveTo;
        if (placed.predecessor) await setEffectiveTo(placed.predecessor.id, addDays(locked.effectiveFrom!, -1));
      }
    }
    const reason = input.reason?.trim() || null;
    const updated = await updateConfig(locked.id, locked, {
      status: to,
      statusReason: reason ?? locked.statusReason,
      ...(action === 'approve' && { approvedBy: caller.accountId, approvedAt: now, selfApproved, effectiveTo }),
      ...(action === 'request_changes' && { dryRunResult: null }),
    });
    if (!updated) throw conflict(locked);
    await recordTransition({ entityType: ENTITY, entityId: locked.id, from: locked.status, to, action, actorId: caller.accountId, reason });
    // Sau khi bản này rời `scheduled`: nới bản trước khi bản này còn trong ràng buộc `config_versions_no_overlap` là chồng ngày.
    if (action === 'cancel' && locked.status === 'scheduled') await reopenPredecessor(locked);

    const result = action === 'approve' && locked.effectiveFrom! <= today ? await activate(updated) : updated;
    return detail(result);
  });
}

/** Huỷ bản đã duyệt: bản đứng trước (đã bị cắt ngày kết thúc vì bản này) chạy tiếp tới bản sau nữa. */
async function reopenPredecessor(cancelled: ConfigRow): Promise<void> {
  const live = (await findCell(cancelled.kind, cancelled.shopId, LIVE)).filter((v) => v.id !== cancelled.id);
  const before = live.find((v) => v.effectiveTo === addDays(cancelled.effectiveFrom!, -1));
  if (before) await setEffectiveTo(before.id, cancelled.effectiveTo);
}

/**
 * `scheduled` → `active` (hệ thống), trong giao dịch và khoá ô của bên gọi. Bản `active` cùng ô đã kết thúc trước ngày
 * này, và bản bị sửa lỗi, sang `expired`. Phát `finance.fee_config_activated`.
 */
async function activate(row: ConfigRow): Promise<ConfigRow> {
  let superseded: string | null = null;
  for (const old of await findCell(row.kind, row.shopId, ['active'])) {
    const ended = old.effectiveTo !== null && old.effectiveTo < row.effectiveFrom!;
    if (!ended && old.id !== row.supersedesId) continue;
    // Bản sửa lỗi cùng ngày hiệu lực: bản cũ không còn ngày nào, giữ khoảng một ngày cho CHECK `config_versions_range`.
    const effectiveTo = old.effectiveTo ?? (old.effectiveFrom! < row.effectiveFrom! ? addDays(row.effectiveFrom!, -1) : old.effectiveFrom);
    const expired = await updateConfig(old.id, old, { status: 'expired', effectiveTo });
    if (expired) {
      await recordTransition({ entityType: ENTITY, entityId: old.id, from: 'active', to: 'expired', action: 'expire', actorId: null });
      superseded = old.id;
    }
  }
  const active = await updateConfig(row.id, row, { status: 'active' });
  if (!active) throw conflict(row);
  await recordTransition({ entityType: ENTITY, entityId: row.id, from: 'scheduled', to: 'active', action: 'activate', actorId: null });
  await publishEvent({
    type: 'finance.fee_config_activated',
    aggregateId: row.id,
    payload: { configVersionId: row.id, kind: row.kind, shopId: row.shopId, effectiveFrom: row.effectiveFrom!, supersededId: superseded },
  });
  return active;
}

/** Áp dụng các bản đã tới ngày của mọi công ty; mỗi bản một giao dịch, lỗi của một bản không chặn bản khác. */
export async function activateDueConfigs(now = new Date()): Promise<number> {
  let done = 0;
  for (const due of await findDueScheduledAnyCompany(vnDate(now), 50)) {
    try {
      await withCompany(due.companyId, async () => {
        const row = await findConfig(due.id);
        if (!row) return;
        await lockCell(row.kind, row.shopId);
        const locked = await findConfig(due.id, 'update');
        if (locked?.status !== 'scheduled' || locked.effectiveFrom! > vnDate(now)) return;
        await activate(locked);
        done++;
      });
    } catch (err) {
      logger.error({ err, configId: due.id }, 'áp dụng phiên bản cấu hình lỗi, thử lại lượt sau');
    }
  }
  return done;
}

const ACTIVATION_LOCK = 'finance.config_activation';

/** Một lượt áp dụng trên mọi bản sao worker (việc nền ở `background.ts`): lượt khác đang chạy thì `busy`. */
export function activateDueConfigsOnce() {
  return withSessionLock(ACTIVATION_LOCK, () => activateDueConfigs());
}
