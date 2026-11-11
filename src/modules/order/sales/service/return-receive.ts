// Kho quét nhận hàng trả, kiện không khớp, gắn và bỏ qua kiện (Documents/21 §20, §15.3; 25 §9). Route gộp dòng nguồn với
// số quét rồi gọi `receiveBack` (cổng §11.1 qua `return-stock-port.ts`); kho cộng chờ xử lý, route không ghi tồn.
import { assertTransition, findAccountSummaries } from '../../../core/index.ts';
import { getVariants } from '../../../product/index.ts';
import {
  findUnmatchedParcel,
  findUnmatchedParcels,
  insertUnmatchedParcel,
  resolveUnmatchedParcel,
  setParcelInspection,
  unmatchedParcelLines,
  type UnmatchedParcelRow,
  type UnmatchedParcelStatus,
} from '../../fulfillment/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import { mergeReceiveLines, returnMachine, type ScanLine } from '../domain/return.ts';
import { takeNextNumber } from '../repository/orders.ts';
import { findReturn, findReturnLines, findReturnsByCode, type ReturnRow, updateReturnAt } from '../repository/returns.ts';
import type { Actor } from './cancel.ts';
import type { SalesContext } from './orders.ts';
import { returnStockPort } from './return-stock-port.ts';
import { applyReturnStep, canViewCost, invalidField, returnView } from './returns.ts';

export interface ReceiveInput {
  code: string;
  note?: string | undefined;
  lines?: ScanLine[] | undefined;
}

/** `variantId` không phải SKU của công ty: 422 theo §15.3 (không ghi gì). */
async function assertOwnVariants(lines: readonly ScanLine[] | undefined): Promise<void> {
  if (!lines?.length) return;
  const known = new Set((await getVariants(lines.map((l) => l.variantId).filter(isUuid))).map((v) => v.id));
  const errors = Object.fromEntries(
    lines.flatMap((l, i) => (known.has(l.variantId) ? [] : [[`lines.${i}.variantId`, 'Biến thể không thuộc công ty']])),
  );
  if (Object.keys(errors).length) throw new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', { errors });
}

const notAwaiting = (current: unknown) =>
  new AppError(409, 'return_not_awaiting', 'Yêu cầu trả không ở trạng thái chờ hàng về', { current });

/** Giá vốn dòng kiện gốc theo SKU cho `meta.unitCosts` (§11.1); SKU nhiều dòng lấy dòng đầu có giá. */
function unitCostsOf(lines: Awaited<ReturnType<typeof findReturnLines>>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const l of lines) if (l.variantId && (out[l.variantId] === undefined || out[l.variantId] === null)) out[l.variantId] = l.unitCost;
  return out;
}

/** Đưa yêu cầu `awaiting_return` sang `received` kèm phiếu kiểm hàng hoàn (quét nhận hoặc gắn kiện đã nhận). */
async function receiveRequest(row: ReturnRow, actor: Actor, scanned: readonly ScanLine[] | undefined, meta: { note?: string; fromUnmatchedParcelId?: string }) {
  const view = { status: row.status, code: row.code };
  if (row.status !== 'awaiting_return') throw notAwaiting(view);
  const { to } = assertTransition(returnMachine, row.status, 'receive', { actor, record: { source: row.source }, view });
  const lines = await findReturnLines([row.id]);
  const merged = mergeReceiveLines(lines, scanned);
  const doc = await returnStockPort().receiveBack({ type: 'return_request', id: row.id }, merged, {
    actorId: actor.accountId,
    number: row.code,
    orderId: row.orderId,
    shopId: row.shopId,
    unitCosts: unitCostsOf(lines),
    ...(meta.note && { note: meta.note }),
    ...(meta.fromUnmatchedParcelId && { fromUnmatchedParcelId: meta.fromUnmatchedParcelId }),
  });
  const ok = await applyReturnStep(
    row,
    { action: 'receive', to, actorId: actor.accountId },
    { inspectionId: doc.documentId, inspectionNumber: doc.number, receivedAt: new Date(), receivedBy: actor.accountId },
  );
  if (!ok) throw new AppError(409, 'version_conflict', 'Yêu cầu trả vừa được cập nhật, tải lại để xem');
  return lines.flatMap((l) => (l.externalLineId ? [l.externalLineId] : []));
}

/** Báo sàn đã nhận hàng trả sau khi app ghi xong; sàn lỗi thì yêu cầu bật Cần xử lý, không lùi việc nhận (§20.1). */
async function confirmOnMarketplace(ctx: SalesContext, actor: Actor, row: ReturnRow, externalLineIds: readonly string[]) {
  if (row.source !== 'marketplace' || !row.shopId || !row.externalReturnId || !ctx.marketplaceReturns) return;
  try {
    await ctx.marketplaceReturns.confirmReceived(actor.companyId, row.shopId, row.externalReturnId, externalLineIds);
  } catch (err) {
    logger.warn({ err, returnRequestId: row.id }, 'báo sàn đã nhận hàng trả lỗi');
    const message = err instanceof AppError ? err.message : 'lỗi không rõ';
    await withCompany(actor.companyId, async () => {
      const fresh = (await findReturn(row.id, { lock: true }))!;
      await updateReturnAt(fresh.id, fresh.version, fresh.status, { needsAttention: true, attentionNote: `Chưa báo được sàn đã nhận hàng: ${message}` });
    });
  }
}

export async function receiveReturn(ctx: SalesContext, actor: Actor, input: ReceiveInput) {
  const code = input.code.trim();
  const note = input.note?.trim() || undefined;
  const opts = { canViewCost: canViewCost(actor) };
  const result = await withCompany(actor.companyId, async () => {
    await assertOwnVariants(input.lines);
    const matches = await findReturnsByCode(code);
    if (matches.length) {
      const row = matches.find((r) => r.status === 'awaiting_return');
      if (!row) throw notAwaiting(await returnView(ctx, matches[0]!, opts));
      const externalLineIds = await receiveRequest(row, actor, input.lines, { ...(note && { note }) });
      return { kind: 'matched' as const, row, externalLineIds };
    }
    // Không khớp yêu cầu nào: vẫn nhận, cờ Cần xử lý là trạng thái `open` của kiện (§20, 25 §9).
    const parcel = await insertUnmatchedParcel({
      code: `KTL-${String(await takeNextNumber('unmatched_parcel')).padStart(6, '0')}`,
      scannedCode: code,
      note: note ?? null,
      receivedBy: actor.accountId,
      lines: input.lines ?? [],
    });
    const known = (input.lines ?? []).filter((l) => l.quantity > 0);
    if (known.length) {
      // Kiện lạ không có số dự kiến để so: dự kiến bằng số quét (đổi 11/11/2026, Documents#103).
      const doc = await returnStockPort().receiveBack(
        { type: 'unmatched_parcel', id: parcel.id },
        mergeReceiveLines([], known).map((l) => ({ ...l, expected: l.scanned })),
        { actorId: actor.accountId, number: parcel.code, ...(note && { note }) },
      );
      await setParcelInspection(parcel.id, doc);
    }
    return { kind: 'unmatched' as const, parcelId: parcel.id };
  });
  if (result.kind === 'matched') {
    await confirmOnMarketplace(ctx, actor, result.row, result.externalLineIds);
    return { kind: 'matched' as const, request: await withCompany(actor.companyId, async () => returnView(ctx, (await findReturn(result.row.id))!, opts)) };
  }
  return { kind: 'unmatched' as const, parcel: await withCompany(actor.companyId, async () => (await parcelViews([(await findUnmatchedParcel(result.parcelId))!]))[0]!) };
}

/** `UnmatchedParcel` (§20 kèm `lines`, `inspection`; tên người theo FE `UserRef`). */
async function parcelViews(rows: readonly UnmatchedParcelRow[]) {
  const ids = rows.map((r) => r.id);
  const [lines, people, requests] = await Promise.all([
    unmatchedParcelLines(ids),
    findAccountSummaries(rows.flatMap((r) => [r.receivedBy, r.resolvedBy].filter((x): x is string => !!x))),
    Promise.all(rows.map((r) => (r.returnRequestId ? findReturn(r.returnRequestId) : undefined))),
  ]);
  const user = (id: string | null) => (id ? { id, name: people.find((p) => p.id === id)?.fullName ?? '' } : null);
  return rows.map((r, i) => ({
    id: r.id,
    code: r.code,
    scannedCode: r.scannedCode,
    note: r.note ?? '',
    status: r.status,
    receivedAt: r.createdAt.toISOString(),
    receivedBy: user(r.receivedBy),
    returnRequest: requests[i] ? { id: requests[i]!.id, code: requests[i]!.code } : null,
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    resolvedBy: user(r.resolvedBy),
    resolution: r.statusReason,
    lines: lines.filter((l) => l.parcelId === r.id).map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
    inspection: r.inspectionId ? { documentId: r.inspectionId, number: r.inspectionNumber ?? '' } : null,
    version: r.version,
  }));
}

export type UnmatchedParcelView = Awaited<ReturnType<typeof parcelViews>>[number];

export async function listUnmatched(companyId: string, status?: UnmatchedParcelStatus) {
  return withCompany(companyId, async () => parcelViews(await findUnmatchedParcels(status)));
}

async function lockOpenParcel(id: string, version: number) {
  const parcel = isUuid(id) ? await findUnmatchedParcel(id, { lock: true }) : undefined;
  if (!parcel) throw new AppError(404, 'not_found', 'Không tìm thấy kiện trả');
  const current = (await parcelViews([parcel]))[0];
  if (parcel.status !== 'open') throw new AppError(409, 'parcel_resolved', 'Kiện đã được xử lý', { current });
  if (parcel.version !== version) throw new AppError(409, 'version_conflict', 'Kiện vừa được cập nhật, tải lại để xem', { current });
  return parcel;
}

/** Gắn kiện đã nhận vào yêu cầu mở sau (E88): yêu cầu sang `received`, không quét lại, không cộng chờ xử lý lần hai. */
export async function attachUnmatched(ctx: SalesContext, actor: Actor, id: string, input: { version: number; returnRequestId: string }) {
  const done = await withCompany(actor.companyId, async () => {
    const parcel = await lockOpenParcel(id, input.version);
    const row = isUuid(input.returnRequestId) ? await findReturn(input.returnRequestId, { lock: true }) : undefined;
    if (!row) throw invalidField('returnRequestId', 'Không tìm thấy yêu cầu trả');
    const scanned = (await unmatchedParcelLines([parcel.id])).map((l) => ({ variantId: l.variantId, quantity: l.quantity }));
    const externalLineIds = await receiveRequest(row, actor, scanned, parcel.inspectionId ? { fromUnmatchedParcelId: parcel.id } : {});
    if (!(await resolveUnmatchedParcel(parcel.id, parcel.version, { status: 'attached', returnRequestId: row.id, resolvedBy: actor.accountId }))) {
      throw new AppError(409, 'version_conflict', 'Kiện vừa được cập nhật, tải lại để xem');
    }
    return { row, externalLineIds };
  });
  await confirmOnMarketplace(ctx, actor, done.row, done.externalLineIds);
  return withCompany(actor.companyId, async () => (await parcelViews([(await findUnmatchedParcel(id))!]))[0]!);
}

/** Bỏ qua kiện: hàng đã cộng vẫn ở chờ xử lý, phiếu kiểm hàng hoàn của kiện vẫn mở (§20). */
export async function dismissUnmatched(actor: Actor, id: string, input: { version: number; reason: string }) {
  return withCompany(actor.companyId, async () => {
    const parcel = await lockOpenParcel(id, input.version);
    await resolveUnmatchedParcel(parcel.id, parcel.version, { status: 'dismissed', statusReason: input.reason.trim(), resolvedBy: actor.accountId });
    return (await parcelViews([(await findUnmatchedParcel(id))!]))[0]!;
  });
}
