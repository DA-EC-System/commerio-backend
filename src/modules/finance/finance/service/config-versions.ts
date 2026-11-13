// Phiên bản cấu hình tiền (#118, #230, Documents/21 §21.4): soạn, chạy thử, gửi duyệt, duyệt (người thứ hai), tự áp
// dụng đúng ngày bằng việc nền, hết hiệu lực (`superseded`) khi bản sau cùng ô có hiệu lực. Sổ tiền (#116) chọn phiên
// bản theo ngày kiện giao bằng `getEffectiveConfig`. Bản có ngày hiệu lực đã qua (hồi tố, bản sửa lỗi) khi sang
// `active` thì ghi dòng `adjustment` cho các kiện trong khoảng hồi tố (25 §10.4, `postRetroactive`).
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
  outputVatPctOf,
  parsePayload,
  pickEffective,
  placeInTimeline,
  taxPctOf,
  vnDate,
} from '../domain/config-version.ts';
import { configDraftsOfDelivered, type Draft, postReturned, RETRO_KINDS, sumDrafts } from '../domain/ledger.ts';
import {
  type ConfigFilter,
  type ConfigRow,
  findCell,
  findConfig,
  findConfigs,
  findDueScheduledAnyCompany,
  insertConfig,
  lockCell,
  retroSources,
  type RetroSource,
  setEffectiveTo,
  sumLedgerSince,
  updateConfig,
} from '../repository/config-versions.ts';
import { insertEntries } from '../repository/ledger.ts';
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

/** Phần doanh thu là GTGT đầu ra với thuế suất `v` phần trăm: v / (100 + v) (25 §6.2, §10.4). */
const vatShare = (v: number) => new Decimal(v).div(new Decimal(100).plus(v));

/**
 * Chạy thử, không ghi sổ: lãi 30 ngày gần nhất theo sổ tiền (`now`) và lãi nếu áp phiên bản này (`next`). Phí sàn,
 * thuế đổi bao nhiêu phần trăm thì lãi đổi bấy nhiêu phần trăm doanh thu. Doanh nghiệp: lãi bỏ phần GTGT đầu ra khỏi
 * doanh thu (25 §10.2), sổ không có dòng này nên trừ ở đây. Cả 30 ngày tính theo loại hình, quy tắc thuế đang áp hôm
 * nay. Loại khác không đổi lãi trực tiếp.
 */
async function computeDryRun(ctx: FinanceContext, row: ConfigRow, now: Date): Promise<DryRun> {
  const today = vnDate(now);
  const { total, revenue: rev } = await sumLedgerSince(addDays(today, -30), row.kind === 'fee' ? row.shopId! : undefined);
  const base = new Decimal(total);
  const revenue = new Decimal(rev);
  const regime = (await effectiveIn('tax_regime', null, today))?.payload as ConfigPayload<'tax_regime'> | undefined;
  const rules = (await effectiveIn('tax_rules', null, today))?.payload as ConfigPayload<'tax_rules'> | undefined;
  const current = base.minus(revenue.times(vatShare(outputVatPctOf(regime, rules))));
  let next = current;
  let feePct: number | null = null;
  let taxPct: number | null = null;
  if (row.kind === 'fee') {
    const cur = await effectiveIn('fee', row.shopId, today);
    feePct = feePctOf(row.payload as ConfigPayload<'fee'>);
    const was = cur ? feePctOf(cur.payload as ConfigPayload<'fee'>) : 0;
    next = current.minus(revenue.times(feePct - was).div(100));
  } else if (row.kind === 'tax_rules') {
    const proposed = row.payload as ConfigPayload<'tax_rules'>;
    taxPct = taxPctOf(proposed);
    next =
      regime?.regime === 'company'
        ? base.minus(revenue.times(vatShare(proposed.outputVatPct)))
        : base.minus(revenue.times(taxPct - (rules ? taxPctOf(rules) : 0)).div(100));
  } else if (row.kind === 'tax_regime' && rules) {
    // Sổ đã trừ thuế sàn khấu trừ khi loại hình hiện tại là hộ kinh doanh, cá nhân; cộng lại rồi trừ theo loại hình mới.
    const withheld = regime && regime.regime !== 'company' ? taxPctOf(rules) : 0;
    const gross = base.plus(revenue.times(withheld).div(100));
    const proposed = (row.payload as ConfigPayload<'tax_regime'>).regime;
    next =
      proposed === 'company'
        ? gross.minus(revenue.times(vatShare(rules.outputVatPct)))
        : gross.minus(revenue.times(taxPctOf(rules)).div(100));
  }
  const rows: DryRun['rows'] = [];
  if (row.shopId) {
    const shop = ctx.shopsOf ? (await ctx.shopsOf([row.shopId])).get(row.shopId) : undefined;
    rows.push({ shopId: row.shopId, shopName: shop?.shopName ?? null, feePct, taxPct, listingsRepriced: null, belowFloor: null });
  }
  return { at: now.toISOString(), rows, profit30: { now: current.round().toNumber(), next: next.round().toNumber() } };
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
  return pickEffective(await findCell(kind, shopId, ['active', 'superseded']), day);
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
    // Duyệt bản đã tới ngày thì áp ngay. Bản bị sửa lỗi (E148) phải rời dòng thời gian trước khi bản này vào
    // `scheduled`, không thì hai khoảng ngày chồng nhau vi phạm `config_versions_no_overlap`.
    const activateNow = action === 'approve' && locked.effectiveFrom! <= today;
    const superseded = activateNow ? await supersedeOld(locked) : null;
    const updated = await updateConfig(locked.id, locked, {
      status: to,
      statusReason: reason ?? locked.statusReason,
      ...(action === 'approve' && { approvedBy: caller.accountId, approvedAt: now, selfApproved, effectiveTo }),
      ...(action === 'request_changes' && { dryRunResult: null }),
    });
    if (!updated) throw conflict(locked);
    await recordTransition({
      entityType: ENTITY,
      entityId: locked.id,
      from: locked.status,
      to,
      action,
      actorId: caller.accountId,
      reason,
      selfApproved,
      audit: { entityType: 'finance.config_versions' },
    });
    // Sau khi bản này rời `scheduled`: nới bản trước khi bản này còn trong ràng buộc `config_versions_no_overlap` là chồng ngày.
    if (action === 'cancel' && locked.status === 'scheduled') await reopenPredecessor(locked);

    const result = activateNow ? await activate(updated, today, superseded) : updated;
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
 * này, và bản bị sửa lỗi, sang `superseded`. Ngày hiệu lực đã qua thì ghi điều chỉnh hồi tố (`postRetroactive`). Phát
 * `finance.fee_config_activated`.
 */
async function activate(row: ConfigRow, today: string, retired: string | null = null): Promise<ConfigRow> {
  const superseded = (await supersedeOld(row)) ?? retired;
  const active = await updateConfig(row.id, row, { status: 'active' });
  if (!active) throw conflict(row);
  await recordTransition({ entityType: ENTITY, entityId: row.id, from: 'scheduled', to: 'active', action: 'activate', actorId: null });
  await postRetroactive(active, today);
  await publishEvent({
    type: 'finance.fee_config_activated',
    aggregateId: row.id,
    payload: { configVersionId: row.id, kind: row.kind, shopId: row.shopId, effectiveFrom: row.effectiveFrom!, supersededId: superseded },
  });
  return active;
}

/**
 * Bản `active` cùng ô đã kết thúc trước ngày hiệu lực của `row`, và bản `row` sửa lỗi, sang `superseded` (hệ thống).
 * Trả id bản cuối cùng đã chuyển, không có thì null.
 */
async function supersedeOld(row: ConfigRow): Promise<string | null> {
  let superseded: string | null = null;
  for (const old of await findCell(row.kind, row.shopId, ['active'])) {
    const ended = old.effectiveTo !== null && old.effectiveTo < row.effectiveFrom!;
    if (!ended && old.id !== row.supersedesId) continue;
    // Bản sửa lỗi cùng ngày hiệu lực: bản cũ không còn ngày nào, giữ khoảng một ngày cho CHECK `config_versions_range`.
    const effectiveTo = old.effectiveTo ?? (old.effectiveFrom! < row.effectiveFrom! ? addDays(row.effectiveFrom!, -1) : old.effectiveFrom);
    const done = await updateConfig(old.id, old, { status: 'superseded', effectiveTo });
    if (done) {
      await recordTransition({ entityType: ENTITY, entityId: old.id, from: 'active', to: 'superseded', action: 'supersede', actorId: null });
      superseded = old.id;
    }
  }
  return superseded;
}

/** Nhóm dòng sổ mỗi loại cấu hình sinh ra (`RETRO_KINDS`); ngưỡng lệch, biên tối thiểu không sinh dòng nên không hồi tố. */
const RETRO_GROUP: Partial<Record<ConfigKind, { group: keyof typeof RETRO_KINDS; configKinds: readonly ConfigKind[] }>> = {
  fee: { group: 'fee', configKinds: ['fee'] },
  tax_regime: { group: 'tax', configKinds: ['tax_regime', 'tax_rules'] },
  tax_rules: { group: 'tax', configKinds: ['tax_regime', 'tax_rules'] },
};
const KIND_LABEL: Record<ConfigKind, string> = {
  fee: 'phí sàn',
  tax_regime: 'loại hình thuế',
  tax_rules: 'quy tắc thuế',
  mismatch_threshold: 'ngưỡng lệch',
  min_margin: 'biên tối thiểu',
};
const SOURCE_LABEL = { fee: { package: 'phí sàn', package_return: 'phí khi hoàn' }, tax: { package: 'thuế sàn khấu trừ', package_return: '' } };
const vnd = (d: Decimal.Value) => new Decimal(d).toFixed(0);

/**
 * Luật hồi tố (25 §10.4, T1; E134, E148): bản vừa sang `active` có ngày hiệu lực không sau hôm nay thì với mọi kiện
 * giao, kiện hoàn của ô trong khoảng [ngày hiệu lực, min(ngày hết, hôm nay)], tính lại khoản theo cấu hình bằng phiên
 * bản đang áp ở ngày phát sinh (lúc này là bản mới) rồi so với số đã ghi (dòng ước tính cùng loại cộng điều chỉnh hồi
 * tố trước đó cùng nhóm). Lệch thì thêm một dòng `adjustment` ước tính, ghi lý do; không sửa dòng cũ. Ngày của dòng
 * là ngày ghi. GTGT đầu ra không có dòng sổ: lãi đọc theo phiên bản của ngày nên tự đổi theo bản mới.
 */
async function postRetroactive(row: ConfigRow, today: string): Promise<number> {
  const scope = RETRO_GROUP[row.kind];
  if (!scope || row.effectiveFrom! > today) return 0;
  const range = { from: row.effectiveFrom!, to: row.effectiveTo !== null && row.effectiveTo < today ? row.effectiveTo : today };
  const shopId = row.kind === 'fee' ? row.shopId! : undefined;
  const entries: Parameters<typeof insertEntries>[0] = [];
  for (const type of ['package', 'package_return'] as const) {
    const kinds = RETRO_KINDS[scope.group][type];
    if (!kinds.length) continue;
    for (const src of await retroSources(type, range, kinds, scope.configKinds, shopId)) {
      const expected = sumDrafts(await expectedCharges(scope.group, type, src));
      const delta = expected.minus(src.charged);
      if (delta.isZero()) continue;
      entries.push({
        companyId: row.companyId,
        kind: 'adjustment',
        amount: delta.toFixed(2),
        isEstimate: true,
        occurredOn: today,
        orderId: src.orderId,
        packageId: src.packageId,
        shopId: src.shopId,
        sourceType: type,
        sourceId: src.sourceId,
        configVersionId: row.id,
        reason:
          `Hồi tố theo phiên bản ${KIND_LABEL[row.kind]} hiệu lực từ ${row.effectiveFrom}: ${SOURCE_LABEL[scope.group][type]} ngày ` +
          `${src.day} đã ghi ${vnd(src.charged)} đ, theo phiên bản mới ${vnd(expected)} đ`,
      });
    }
  }
  await insertEntries(entries);
  return entries.length;
}

/** Khoản theo cấu hình của một nguồn, tính bằng phiên bản đang áp ở ngày phát sinh của nguồn đó. */
async function expectedCharges(group: keyof typeof RETRO_KINDS, type: 'package' | 'package_return', src: RetroSource): Promise<Draft[]> {
  if (group === 'fee') {
    const fee = await getEffectiveConfig('fee', src.shopId, src.day);
    return type === 'package' ? configDraftsOfDelivered(src.revenue, { fee }) : postReturned(fee);
  }
  const regime = await getEffectiveConfig('tax_regime', null, src.day);
  const rules = await getEffectiveConfig('tax_rules', null, src.day);
  return configDraftsOfDelivered(src.revenue, { regime, rules });
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
        await activate(locked, vnDate(now));
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
