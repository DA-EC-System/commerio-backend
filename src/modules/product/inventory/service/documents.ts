// Phiếu kho có duyệt (#208; Documents/21 mục 15.2–15.4, 25 §7): kiểm kê, xuất huỷ, chuyển chờ xử lý do kho lập,
// người có quyền duyệt duyệt; kiểm hàng về do hệ thống lập khi hàng quay về. Phiếu giảm đang chờ duyệt tạm khoá phần giảm
// (tính khi đọc, `pendingLocks`). Ghi sổ đi qua lõi `applyMoves`.
import { AppError } from '../../../../shared/errors/app-error.ts';
import { currentCompanyId, withCompany } from '../../../../shared/db/client.ts';
import { assertTransition, canSelfApprove, publishEvent, recordAudit, recordTransition } from '../../../core/index.ts';
import { getVariants } from '../../catalog/index.ts';
import {
  DOC_PREFIX,
  type DocAction,
  type DocStatus,
  type DocType,
  machineOf,
  type ManualDocType,
  missingOf,
  needsDecision,
} from '../domain/stock-document.ts';
import { takeNextNumber } from '../repository/counters.ts';
import {
  type DocLineRow,
  type DocRow,
  findDoc,
  insertDoc,
  insertDocLines,
  linesOfDocs,
  listDocs,
  type NewDocLine,
  insertOpeningDoc,
  openingDocOf,
  replaceDocLines,
  setLineCosts,
  updateDoc,
} from '../repository/documents.ts';
import { DOC_AUDIT_ENTITY, DOC_ENTITY, detail, summaries, supplierReturnPort } from './document-views.ts';
import { InsufficientStock, applyMoves, type Move } from './posting.ts';
import { lockedOf, stockOf } from './port.ts';
import { notFound, type Viewer } from './views.ts';

export interface DocActor extends Viewer {
  readonly permissions: readonly string[];
  readonly enabledModules: readonly string[];
}

export interface DocLineInput {
  variantId: string;
  quantity?: number | undefined;
  counted?: number | undefined;
  scanned?: number | undefined;
  resell?: number | undefined;
  damaged?: number | undefined;
  toSupplier?: number | undefined;
}

type Errors = Record<string, string>;
const invalid = (errors: Errors, code = 'validation_failed') => new AppError(422, code, 'Dữ liệu gửi lên không hợp lệ', { errors });
const isQty = (n: unknown, min: number) => Number.isInteger(n) && (n as number) >= min;
const bucketOf = (area: 'stock' | 'quarantine' | undefined) => (area === 'quarantine' ? 'quarantine' : 'on_hand');
const MAX_LINES = 200;

async function number(type: DocType) {
  return `${DOC_PREFIX[type]}-${String(await takeNextNumber(type)).padStart(6, '0')}`;
}

async function load(id: string, lock?: 'update'): Promise<DocRow> {
  const row = /^[0-9a-f-]{36}$/i.test(id) ? await findDoc(id, lock) : undefined;
  if (!row || row.kind === 'shipment' || row.kind === 'shipment_reversal') throw notFound('phiếu kho');
  return row;
}

async function conflict(row: DocRow, viewer: DocActor) {
  return new AppError(409, 'version_conflict', 'Phiếu vừa được người khác sửa hoặc xử lý', { current: await detail(row, viewer) });
}

// ---------- Đọc ----------

export function listDocuments(viewer: Viewer, q: { page: number; pageSize: number; type?: DocType; status?: DocStatus; search?: string }) {
  return withCompany(viewer.companyId, async () => {
    const kinds = q.type ? [q.type] : (['stocktake', 'write_off', 'to_quarantine', 'return_inspection'] as const);
    const { rows, total } = await listDocs(
      { kinds, status: q.status, search: q.search },
      { limit: q.pageSize, offset: (q.page - 1) * q.pageSize },
    );
    return { items: await summaries(rows), total, page: q.page, pageSize: q.pageSize };
  });
}

export function getDocument(viewer: Viewer, id: string) {
  return withCompany(viewer.companyId, async () => detail(await load(id), viewer));
}

// ---------- Lập, sửa phiếu lập tay ----------

/** Biến thể đang bán của công ty, không lặp; lỗi theo ô `lines.i.variantId`. */
async function checkVariants(input: readonly DocLineInput[], errors: Errors, skip: (l: DocLineInput) => boolean = () => false) {
  const variants = new Map((await getVariants(input.map((l) => l.variantId))).map((v) => [v.id, v]));
  const seen = new Set<string>();
  input.forEach((l, i) => {
    if (skip(l)) {
      seen.add(l.variantId);
      return;
    }
    const v = variants.get(l.variantId);
    if (!v || v.archived) errors[`lines.${i}.variantId`] = 'Biến thể không còn bán';
    else if (seen.has(l.variantId)) errors[`lines.${i}.variantId`] = 'Biến thể bị lặp';
    seen.add(l.variantId);
  });
}

/**
 * Dòng của phiếu lập tay. Kiểm kê chụp tồn sổ của ngăn lúc lưu để Δ không lẫn biến động sau lúc đếm. `unlimited`: kiểm kê
 * đầu kỳ (nguồn `shop_setup`) có mỗi SKU đang bán một dòng nên không giới hạn số dòng (Documents/21 mục 11.3, #278).
 */
async function manualLines(
  type: ManualDocType,
  bucket: 'on_hand' | 'quarantine',
  note: string,
  input: readonly DocLineInput[],
  { unlimited = false }: { unlimited?: boolean } = {},
) {
  const errors: Errors = {};
  if (note.length > 500) errors.note = 'Ghi chú tối đa 500 ký tự';
  else if (type !== 'stocktake' && !note) errors.note = 'Nhập lý do';
  if (!input.length) errors.lines = 'Thêm ít nhất một dòng';
  if (!unlimited && input.length > MAX_LINES) errors.lines = `Tối đa ${MAX_LINES} dòng một phiếu`;
  await checkVariants(input, errors);
  const book = type === 'stocktake' ? await stockOf(input.map((l) => l.variantId)) : new Map();
  const lines: NewDocLine[] = input.map((l, i) => {
    if (type === 'stocktake') {
      if (!isQty(l.counted, 0)) errors[`lines.${i}.counted`] = 'Số đếm là số nguyên không âm';
      const s = book.get(l.variantId);
      return { variantId: l.variantId, bookQty: bucket === 'on_hand' ? (s?.onHand ?? 0) : (s?.quarantine ?? 0), countedQty: l.counted ?? 0 };
    }
    if (!isQty(l.quantity, 1)) errors[`lines.${i}.quantity`] = 'Số lượng là số nguyên từ 1';
    return { variantId: l.variantId, quantity: l.quantity ?? 1 };
  });
  if (Object.keys(errors).length) throw invalid(errors);
  return lines;
}

export function createDocument(
  actor: DocActor,
  input: { type: ManualDocType; area?: 'stock' | 'quarantine'; note: string; lines: DocLineInput[] },
) {
  return withCompany(actor.companyId, async () => {
    const bucket = input.type === 'to_quarantine' ? 'on_hand' : bucketOf(input.area);
    const note = input.note.trim();
    const lines = await manualLines(input.type, bucket, note, input.lines);
    const row = await insertDoc({
      companyId: actor.companyId,
      number: await number(input.type),
      kind: input.type,
      area: bucket,
      countedAt: input.type === 'stocktake' ? new Date() : null,
      note,
      createdBy: actor.accountId,
    });
    await insertDocLines(actor.companyId, row.id, lines);
    await recordTransition({ entityType: DOC_ENTITY, entityId: row.id, from: null, to: 'draft', action: 'create', actorId: actor.accountId });
    await recordAudit({
      companyId: actor.companyId,
      actorId: actor.accountId,
      action: 'create',
      entityType: DOC_AUDIT_ENTITY,
      entityId: row.id,
      after: { code: row.number, kind: row.kind, area: row.area, note, lines: lines.length },
    });
    return detail(row, actor);
  });
}

/** Dòng của kiểm hàng về: dòng dự kiến luôn còn, dòng thêm là SKU thực nhận khi sai mẫu (dự kiến 0). */
async function inspectionLines(existing: readonly DocLineRow[], input: readonly DocLineInput[]) {
  const errors: Errors = {};
  const expected = existing.filter((l) => (l.expectedQty ?? 0) > 0);
  const byVariant = new Map(input.map((l) => [l.variantId, l]));
  const extra = input.filter((l) => !expected.some((e) => e.variantId === l.variantId));
  const all: DocLineInput[] = [...expected.map((e) => byVariant.get(e.variantId) ?? { variantId: e.variantId }), ...extra];
  if (all.length > MAX_LINES) errors.lines = `Tối đa ${MAX_LINES} dòng một phiếu`;
  await checkVariants(all, errors, (l) => expected.some((e) => e.variantId === l.variantId));
  const lines: NewDocLine[] = all.map((l, i) => {
    const old = expected.find((e) => e.variantId === l.variantId);
    const scanned = l.scanned ?? 0;
    const parts = [l.resell ?? 0, l.damaged ?? 0, l.toSupplier ?? 0];
    if (!isQty(scanned, 0)) errors[`lines.${i}.scanned`] = 'Số quét là số nguyên không âm';
    else if (!old && scanned < 1) errors[`lines.${i}.scanned`] = 'Dòng sai mẫu cần số quét từ 1';
    if (!parts.every((p) => isQty(p, 0))) errors[`lines.${i}.resell`] = 'Số chia là số nguyên không âm';
    else if (parts[0]! + parts[1]! + parts[2]! !== scanned) errors[`lines.${i}.resell`] = 'Bán lại + hỏng + trả NCC phải bằng số quét';
    return {
      variantId: l.variantId,
      expectedQty: old?.expectedQty ?? 0,
      scannedQty: scanned,
      resellQty: parts[0],
      damagedQty: parts[1],
      toSupplierQty: parts[2],
      unitCost: old?.unitCost ?? null,
    };
  });
  if (Object.keys(errors).length) throw invalid(errors);
  return lines;
}

/** Phần chênh số quét theo SKU giữa dòng cũ và dòng mới của phiếu kiểm hàng về, thành move ngăn chờ xử lý. */
function scanDelta(old: readonly DocLineRow[], next: readonly NewDocLine[]): Move[] {
  const delta = new Map<string, number>();
  for (const l of old) delta.set(l.variantId, (delta.get(l.variantId) ?? 0) - (l.scannedQty ?? 0));
  for (const l of next) delta.set(l.variantId, (delta.get(l.variantId) ?? 0) + (l.scannedQty ?? 0));
  return [...delta].map(([variantId, qty]) => ({ variantId, bucket: 'quarantine', qty, unitCost: null, sourceLineId: null }));
}

export function updateDocument(
  actor: DocActor,
  id: string,
  input: { area?: 'stock' | 'quarantine'; note: string; lines: DocLineInput[]; version: number },
) {
  return withCompany(actor.companyId, async () => {
    const row = await load(id, 'update');
    if (row.version !== input.version) throw await conflict(row, actor);
    if (row.status !== 'draft') throw new AppError(409, 'not_draft', 'Chỉ sửa được phiếu nháp');
    const note = input.note.trim();
    let lines: NewDocLine[];
    let area = row.area;
    let scanMoves: Move[] = [];
    if (row.kind === 'return_inspection') {
      const old = (await linesOfDocs([row.id])).get(row.id) ?? [];
      lines = await inspectionLines(old, input.lines);
      scanMoves = scanDelta(old, lines);
    } else {
      // Kiểm kê đầu kỳ (nguồn `shop_setup`) và chuyển chờ xử lý luôn đếm tồn thực
      if (row.kind === 'write_off' || (row.kind === 'stocktake' && !row.isOpening)) area = bucketOf(input.area ?? (row.area === 'on_hand' ? 'stock' : 'quarantine'));
      lines = await manualLines(row.kind as ManualDocType, area, note, input.lines, { unlimited: row.isOpening });
    }
    const updated = await updateDoc(row.id, row.version, { area, note, ...(row.kind === 'stocktake' && { countedAt: new Date() }) });
    if (!updated) throw await conflict(row, actor);
    await replaceDocLines(actor.companyId, row.id, lines);
    // Hàng về đã cộng chờ xử lý lúc quét nhận: sửa số quét thì chờ xử lý đổi đúng phần chênh (§15.3, 25 §7.3)
    try {
      await applyMoves({ type: 'stock_document', id: row.id }, scanMoves, actor.accountId);
    } catch (err) {
      if (!(err instanceof InsufficientStock)) throw err;
      const errors: Errors = {};
      lines.forEach((l, i) => {
        if (err.variantIds.includes(l.variantId)) errors[`lines.${i}.scanned`] = 'Chờ xử lý không còn đủ hàng để giảm số quét';
      });
      throw invalid(Object.keys(errors).length ? errors : { lines: 'Chờ xử lý không còn đủ hàng để giảm số quét' }, 'stock_insufficient');
    }
    return detail(updated, actor);
  });
}

// ---------- Thao tác theo máy trạng thái ----------

/** Gửi duyệt phiếu giảm: đủ hàng ở ngăn nguồn mới gửi (kiểm kê không chặn: thiếu là kết quả đếm). */
async function checkDecrease(row: DocRow, lines: readonly DocLineRow[]) {
  if (row.kind === 'stocktake') return;
  const stock = await stockOf(lines.map((l) => l.variantId));
  const errors: Errors = {};
  lines.forEach((l, i) => {
    const s = stock.get(l.variantId);
    const has = row.area === 'on_hand' ? (s?.available ?? 0) : (s?.quarantine ?? 0);
    if ((l.quantity ?? 0) > has) errors[`lines.${i}.quantity`] = `Chỉ còn ${has} ${row.area === 'on_hand' ? 'khả dụng' : 'chờ xử lý'}`;
  });
  if (Object.keys(errors).length) throw invalid(errors, 'stock_insufficient');
}

function movesOf(row: DocRow, lines: readonly DocLineRow[]): Move[] {
  const area = row.area;
  return lines.flatMap((l): Move[] => {
    const base = { variantId: l.variantId, unitCost: null, sourceLineId: l.id };
    switch (row.kind) {
      case 'stocktake':
        return [{ ...base, bucket: area, qty: (l.countedQty ?? 0) - (l.bookQty ?? 0) }];
      case 'write_off':
        return [{ ...base, bucket: area, qty: -(l.quantity ?? 0) }];
      case 'to_quarantine':
        return [
          { ...base, bucket: 'on_hand', qty: -(l.quantity ?? 0) },
          { ...base, bucket: 'quarantine', qty: l.quantity ?? 0 },
        ];
      case 'return_inspection':
        // Cả số quét đã ở chờ xử lý từ lúc nhận (`receiveBack`): phần bán lại chuyển sang tồn thực theo giá vốn dòng
        // kiện (tính lại bình quân; dòng không có giá thì giữ bình quân hiện tại), hỏng và trả NCC ở lại (25 §7.1, §7.3)
        return [
          { ...base, bucket: 'quarantine', qty: -(l.resellQty ?? 0) },
          { ...base, bucket: 'on_hand', qty: l.resellQty ?? 0, unitCost: l.unitCost },
        ];
      default:
        return [];
    }
  });
}

/**
 * Ghi sổ: đổi tồn qua lõi, chốt giá vốn trên dòng. Kiểm kê đã duyệt được làm tồn âm (25 §7.1); phiếu khác thiếu hàng
 * thì 422 `stock_insufficient` theo dòng.
 */
async function post(row: DocRow, lines: readonly DocLineRow[], actorId: string, now: Date) {
  if (row.kind === 'return_inspection') {
    const errors: Errors = {};
    lines.forEach((l, i) => {
      if ((l.resellQty ?? 0) + (l.damagedQty ?? 0) + (l.toSupplierQty ?? 0) !== (l.scannedQty ?? 0)) {
        errors[`lines.${i}.resell`] = 'Bán lại + hỏng + trả NCC phải bằng số quét';
      }
    });
    if (Object.keys(errors).length) throw invalid(errors);
  }
  const before = await stockOf(lines.map((l) => l.variantId));
  try {
    await applyMoves({ type: 'stock_document', id: row.id }, movesOf(row, lines), actorId, { allowBreak: row.kind === 'stocktake' });
  } catch (err) {
    if (!(err instanceof InsufficientStock)) throw err;
    const errors: Errors = {};
    lines.forEach((l, i) => {
      if (err.variantIds.includes(l.variantId)) errors[`lines.${i}.quantity`] = 'Không đủ hàng để ghi sổ';
    });
    throw invalid(errors, 'stock_insufficient');
  }
  // Kiểm hàng về đã có giá vốn của dòng kiện gốc thì giữ, phiếu khác chốt giá vốn bình quân lúc ghi sổ
  await setLineCosts(new Map(lines.filter((l) => l.unitCost === null).map((l) => [l.id, before.get(l.variantId)?.avgCost ?? '0'])));
  if (row.kind === 'stocktake') {
    await publishEvent({
      type: 'inventory.stocktake_posted',
      aggregateId: row.id,
      payload: {
        documentId: row.id,
        number: row.number,
        source: row.sourceType === 'shop_setup' && row.sourceId ? { type: 'shop_setup', shopId: row.sourceId } : null,
        postedAt: now.toISOString(),
        // CHECK `stock_documents_counted_at` ép phiếu kiểm kê luôn có thời điểm đếm
        countedAt: row.countedAt!.toISOString(),
        lines: lines.map((l) => ({ variantId: l.variantId, countedQty: l.countedQty ?? 0, delta: (l.countedQty ?? 0) - (l.bookQty ?? 0) })),
      },
    });
  }
  if (row.kind === 'return_inspection') await afterInspection(row, lines, actorId);
}

/** Kiểm hàng về ghi sổ: hỏng sinh phiếu xuất huỷ nháp, trả NCC sinh phiếu trả NCC nháp; nguồn yêu cầu trả thì phát sự kiện. */
async function afterInspection(row: DocRow, lines: readonly DocLineRow[], actorId: string) {
  const damaged = lines.filter((l) => (l.damagedQty ?? 0) > 0);
  if (damaged.length) {
    await createQuarantineWriteOff(
      { type: 'stock_document', id: row.id },
      damaged.map((l) => ({ variantId: l.variantId, quantity: l.damagedQty! })),
      `Hàng hỏng từ ${row.number}`,
      actorId,
    );
  }
  const toSupplier = lines.filter((l) => (l.toSupplierQty ?? 0) > 0);
  if (toSupplier.length) {
    await supplierReturnPort().draft({
      source: 'customer_return',
      sourceId: row.id,
      lines: toSupplier.map((l) => ({ variantId: l.variantId, quantity: l.toSupplierQty!, unitCost: l.unitCost, sourceLineId: l.id })),
      note: `Hàng trả NCC từ ${row.number}`,
    });
  }
  if (row.sourceType === 'return_request' && row.orderId) {
    // `return_inspected.shopId` không null (Documents/21 §11.2, #308): yêu cầu trả chỉ đến từ sàn nên luôn có gian hàng.
    // Thiếu là lỗi của bên gọi `receiveBack`: báo lỗi, không bỏ sự kiện (bỏ thì yêu cầu trả kẹt, sổ thiếu `cogs_reversal`).
    if (!row.shopId) throw new Error(`Phiếu kiểm hàng hoàn ${row.number} nguồn yêu cầu trả thiếu gian hàng`);
    await publishEvent({
      type: 'inventory.return_inspected',
      aggregateId: row.id,
      payload: {
        inspectionId: row.id,
        orderId: row.orderId,
        shopId: row.shopId,
        inspectedAt: new Date().toISOString(),
        lines: lines.map((l) => ({ variantId: l.variantId, resellable: l.resellQty ?? 0, unitCost: l.unitCost })),
      },
    });
  }
}

/**
 * Tạm khoá của SKU đổi (gửi duyệt giữ lại, từ chối nhả ra) thì phát `inventory.stock_changed` như khi tồn thực đổi
 * (Documents/21 §11.1; US-TK-06, US-TK-09): sàn được đẩy số khả dụng mới, kiện Thiếu hàng được chia lại. SKU đã có move
 * tồn thực trong lần ghi sổ này thì lõi đã phát, không phát lần hai.
 */
async function publishLockChanges(variantIds: readonly string[], before: ReadonlyMap<string, number>, posted: readonly Move[]) {
  const after = await lockedOf(variantIds);
  const byCore = new Set(posted.filter((m) => m.bucket === 'on_hand' && m.qty !== 0).map((m) => m.variantId));
  const changed = variantIds.filter((id) => (before.get(id) ?? 0) !== (after.get(id) ?? 0) && !byCore.has(id)).sort();
  const stock = await stockOf(changed);
  for (const variantId of changed) {
    const s = stock.get(variantId);
    if (!s) continue;
    await publishEvent({
      type: 'inventory.stock_changed',
      aggregateId: variantId,
      payload: { variantId, onHand: s.onHand, reserved: s.reserved, available: s.available },
    });
  }
}

export function actOnDocument(actor: DocActor, id: string, action: DocAction, input: { version: number; reason?: string | undefined }) {
  return withCompany(actor.companyId, async () => {
    const row = await load(id, 'update');
    if (row.version !== input.version) throw await conflict(row, actor);
    const lines = (await linesOfDocs([row.id])).get(row.id) ?? [];
    const type = row.kind as DocType;
    const reason = input.reason?.trim() || null;
    const record = {
      createdBy: row.createdBy,
      lineCount: lines.length,
      missing: missingOf(lines.map((l) => ({ expected: l.expectedQty ?? 0, scanned: l.scannedQty ?? 0 }))),
    };
    // Hỏi `canSelfApprove` chỉ khi người làm là người lập (người quét): lúc đó bước người thứ hai mới xét tự duyệt.
    const canSelf = row.createdBy === actor.accountId && (await canSelfApprove(actor.accountId));
    let result: { to: DocStatus; selfApproved: boolean };
    try {
      result = assertTransition(machineOf(type), row.status, action, { actor, record, reason, canSelfApprove: canSelf });
    } catch (err) {
      if (err instanceof AppError && err.code === 'invalid_transition') {
        throw new AppError(409, err.code, err.message, { current: await detail(row, actor) });
      }
      throw err;
    }
    const { to, selfApproved } = result;
    const now = new Date();
    const set: Parameters<typeof updateDoc>[2] = { status: to };

    if (type !== 'return_inspection' && action === 'submit') await checkDecrease(row, lines);
    if (action === 'reject') set.statusReason = reason;
    if (type === 'return_inspection' && action === 'submit') Object.assign(set, { claimFlag: true, createdBy: row.createdBy ?? actor.accountId });
    // Kiểm kê đầu kỳ do hệ thống lập: người gửi duyệt (người đếm) thành người lập để xét người thứ hai (25 §11, N9)
    if (row.isOpening && action === 'submit') set.createdBy = actor.accountId;
    if (to === 'posted') {
      Object.assign(set, { postedBy: actor.accountId, postedAt: now });
      if (action === 'approve') Object.assign(set, { approvedBy: actor.accountId, approvedAt: now, selfApproved });
    }
    const variantIds = [...new Set(lines.map((l) => l.variantId))];
    const locksBefore = type === 'return_inspection' ? new Map<string, number>() : await lockedOf(variantIds);

    // Đổi trạng thái trước khi ghi sổ: phiếu hết `pending` thì hết tạm khoá, số khả dụng lõi phát ra mới đúng
    const updated = await updateDoc(row.id, row.version, set);
    if (!updated) throw await conflict(row, actor);
    if (to === 'posted') await post(row, lines, actor.accountId, now);
    if (type !== 'return_inspection') await publishLockChanges(variantIds, locksBefore, to === 'posted' ? movesOf(row, lines) : []);
    await recordTransition({
      entityType: DOC_ENTITY,
      entityId: row.id,
      from: row.status,
      to,
      action,
      actorId: actor.accountId,
      reason,
      selfApproved,
      audit: { entityType: DOC_AUDIT_ENTITY, label: row.number },
    });
    return detail(updated, actor);
  });
}

/** Xuất huỷ hàng chờ xử lý bị từ chối: nhập lại tồn thực hoặc lập phiếu trả NCC nháp (§15.3). */
export function decideDocument(actor: DocActor, id: string, input: { decision: 'restock' | 'supplier_return'; version: number }) {
  return withCompany(actor.companyId, async () => {
    const row = await load(id, 'update');
    if (row.version !== input.version) throw await conflict(row, actor);
    if (row.rejectDecision) throw new AppError(409, 'decision_made', 'Phiếu đã chọn cách xử lý hàng');
    if (!needsDecision(row)) {
      throw new AppError(409, 'invalid_transition', 'Chỉ chọn cách xử lý cho xuất huỷ hàng chờ xử lý bị từ chối', {
        current: await detail(row, actor),
      });
    }
    const lines = (await linesOfDocs([row.id])).get(row.id) ?? [];
    if (input.decision === 'restock') {
      const moves = lines.flatMap((l): Move[] => [
        { variantId: l.variantId, bucket: 'quarantine', qty: -(l.quantity ?? 0), unitCost: null, sourceLineId: l.id },
        { variantId: l.variantId, bucket: 'on_hand', qty: l.quantity ?? 0, unitCost: null, sourceLineId: l.id },
      ]);
      try {
        await applyMoves({ type: 'stock_document', id: row.id }, moves, actor.accountId);
      } catch (err) {
        if (err instanceof InsufficientStock) throw invalid({ lines: 'Chờ xử lý không còn đủ hàng' }, 'stock_insufficient');
        throw err;
      }
    } else {
      await supplierReturnPort().draft({
        source: 'write_off_rejected',
        sourceId: row.id,
        lines: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity ?? 0, unitCost: l.unitCost, sourceLineId: l.id })),
        note: `Hàng của ${row.number} bị từ chối xuất huỷ`,
      });
    }
    const updated = await updateDoc(row.id, row.version, { rejectDecision: input.decision });
    if (!updated) throw await conflict(row, actor);
    await recordAudit({
      companyId: actor.companyId,
      actorId: actor.accountId,
      action: 'update',
      entityType: DOC_AUDIT_ENTITY,
      entityId: row.id,
      before: { code: row.number, rejectDecision: null },
      after: { code: row.number, rejectDecision: input.decision },
    });
    return detail(updated, actor);
  });
}

// ---------- Phiếu do hệ thống lập (module khác gọi, trong `withCompany` của bên gọi) ----------

export interface StockLine {
  variantId: string;
  quantity: number;
}

/**
 * Phiếu xuất huỷ nháp từ chờ xử lý: hàng hỏng của kiểm hàng về, phiếu trả NCC bị huỷ chọn xuất huỷ (#210).
 * `actorId`: người làm bước sinh ra phiếu này, thành người lập.
 */
export async function createQuarantineWriteOff(
  source: { type: string; id: string; number?: string | null },
  lines: readonly StockLine[],
  note: string,
  actorId: string | null,
): Promise<{ documentId: string; number: string }> {
  const row = await insertDoc({
    companyId: currentCompanyId()!,
    number: await number('write_off'),
    kind: 'write_off',
    area: 'quarantine',
    sourceType: source.type,
    sourceId: source.id,
    sourceNumber: source.number ?? null,
    note,
    createdBy: actorId,
  });
  await insertDocLines(row.companyId, row.id, lines.filter((l) => l.quantity > 0).map((l) => ({ variantId: l.variantId, quantity: l.quantity })));
  await recordTransition({ entityType: DOC_ENTITY, entityId: row.id, from: null, to: 'draft', action: 'create', actorId: null });
  return { documentId: row.id, number: row.number };
}

/**
 * Phiếu kiểm kê đầu kỳ cho gian hàng đầu tiên của công ty (Documents/21 mục 11.3, 25 §6.1; #245), channel gọi khi thiết
 * lập (#198). Lập nháp nguồn `shop_setup`, mỗi SKU đang bán một dòng, số đếm điền sẵn bằng tồn thực. Gọi lại khi gian
 * hàng đã có phiếu đang mở thì trả phiếu cũ (`created: false`); hai lần gọi đua nhau chặn bằng unique
 * `stock_documents_opening_uq`. Ghi sổ phát `inventory.stocktake_posted` kèm `source`.
 */
export async function createOpeningStocktake(
  shopId: string,
  opts: { actorId: string | null },
): Promise<{ documentId: string; number: string; created: boolean }> {
  const existing = await openingDocOf(shopId);
  if (existing) return { documentId: existing.id, number: existing.number, created: false };
  const companyId = currentCompanyId()!;
  const variants = (await getVariants()).filter((v) => !v.archived);
  const stock = await stockOf(variants.map((v) => v.id));
  const row = await insertOpeningDoc({
    companyId,
    number: await number('stocktake'),
    kind: 'stocktake',
    area: 'on_hand',
    countedAt: new Date(),
    isOpening: true,
    sourceType: 'shop_setup',
    sourceId: shopId,
    note: 'Kiểm kê đầu kỳ khi kết nối gian hàng đầu tiên',
    // Hệ thống lập; người bấm thiết lập chỉ ghi ở lịch sử, người gửi duyệt mới thành người lập (`actOnDocument`)
    createdBy: null,
  });
  if (!row) {
    const other = (await openingDocOf(shopId))!;
    return { documentId: other.id, number: other.number, created: false };
  }
  await insertDocLines(
    companyId,
    row.id,
    variants.map((v) => {
      const onHand = stock.get(v.id)?.onHand ?? 0;
      return { variantId: v.id, bookQty: onHand, countedQty: Math.max(0, onHand) };
    }),
  );
  await recordTransition({ entityType: DOC_ENTITY, entityId: row.id, from: null, to: 'draft', action: 'create', actorId: opts.actorId });
  return { documentId: row.id, number: row.number, created: true };
}
