// Yêu cầu trả từ sàn (#202, Documents/25 §9, Documents/21 §20.1): channel kéo về rồi gọi `ingestMarketplaceReturn` trong
// `withCompany`; kiểm hàng hoàn xong (`inventory.return_inspected`) thì đóng yêu cầu. Sàn là nguồn của trạng thái yêu cầu
// trước khi hàng về; app là nguồn của nhận hàng (quét) và kiểm hàng.
import { requireCompanyId } from '../../../../shared/db/client.ts';
import { deliverForReturn, packageLinesOfOrderLines } from '../../fulfillment/index.ts';
import { distributeResell, refundAmountOf, type ReturnStatus, syncAction, weightedUnitCost } from '../domain/return.ts';
import { lockMarketplaceOrder, takeNextNumber } from '../repository/orders.ts';
import {
  findMarketplaceReturn,
  findReturnByInspection,
  findReturnLines,
  insertReturn,
  insertReturnLines,
  orderLinesByExternal,
  type ReturnPatch,
  type ReturnRow,
  updateReturnAt,
  updateReturnLine,
} from '../repository/returns.ts';
import { applyReturnStep } from './returns.ts';

/** Yêu cầu trả của sàn đã chuẩn hoá (channel đổi từ `RemoteReturn`). Tiền là chuỗi thập phân. */
export interface PlatformReturn {
  shopId: string;
  externalReturnId: string;
  externalOrderId: string;
  /** `replacement` (đổi hàng) chưa có luồng: bỏ qua. */
  kind: 'return' | 'refund' | 'replacement';
  /** Trạng thái app ứng với trạng thái sàn; null khi sàn trả giá trị app chưa hiểu (chỉ cập nhật thông tin sàn). */
  status: ReturnStatus | null;
  rawStatus: string;
  ofcStatus: string | null;
  disputeInProgress: boolean;
  returnTo: 'warehouse' | 'merchant' | null;
  returnTrackingCode: string | null;
  reason: string | null;
  refundAmount: string | null;
  lines: { externalLineId: string; externalReturnLineId: string | null; quantity: number }[];
  updatedAt: Date;
}

export type ReturnIngestOutcome = 'created' | 'updated' | 'unchanged' | 'unknown_order' | 'skipped';

const pad = (n: number) => String(n).padStart(6, '0');

/** Thông tin sàn chép mỗi lần kéo (R11, chỉ để hiện). */
function platformFields(r: PlatformReturn): ReturnPatch {
  return {
    rawMarketplaceStatus: r.rawStatus,
    ofcStatus: r.ofcStatus,
    disputeInProgress: r.disputeInProgress,
    returnTo: r.returnTo,
    returnTrackingCode: r.returnTrackingCode,
    externalUpdatedAt: r.updatedAt,
    ...(r.refundAmount !== null && { refundAmount: r.refundAmount }),
  };
}

/**
 * Tạo hoặc cập nhật yêu cầu trả theo (gian hàng, mã yêu cầu sàn). Đơn chưa có trong app thì bỏ (`unknown_order`):
 * lượt kéo đơn sau mang đơn về, lượt kéo yêu cầu sau mới gắn. Gọi trong `withCompany` (một giao dịch).
 */
export async function ingestMarketplaceReturn(r: PlatformReturn): Promise<ReturnIngestOutcome> {
  if (r.kind === 'replacement') return 'skipped';
  const existing = await findMarketplaceReturn(r.shopId, r.externalReturnId);
  if (existing) return syncExisting(existing, r);
  const order = await lockMarketplaceOrder(r.shopId, r.externalOrderId);
  if (!order) return 'unknown_order';
  const row = await createRequest(order.id, r);
  if (!row) {
    // Lần kéo khác vừa tạo cùng yêu cầu: khoá đọc lại rồi đi như cập nhật.
    return syncExisting((await findMarketplaceReturn(r.shopId, r.externalReturnId))!, r);
  }
  // Tạo ở `requested` rồi đi theo máy trạng thái tới trạng thái sàn: lịch sử, sự kiện tiền như một lần chuyển thường.
  if (r.status && r.status !== 'requested') await syncExisting(row, r);
  return 'created';
}

async function createRequest(orderId: string, r: PlatformReturn): Promise<ReturnRow | undefined> {
  const orderLines = await orderLinesByExternal(orderId, r.lines.map((l) => l.externalLineId));
  const byExternal = new Map(orderLines.map((l) => [l.externalLineId!, l]));
  // Gộp các món về dòng đơn (Lazada mỗi món một dòng số lượng 1); mã dòng đơn ngược lấy món đầu.
  const lines = new Map<string, { orderLine: (typeof orderLines)[number]; quantity: number; externalReturnLineId: string | null }>();
  const missing: string[] = [];
  for (const l of r.lines) {
    const orderLine = byExternal.get(l.externalLineId);
    if (!orderLine) {
      missing.push(l.externalLineId);
      continue;
    }
    const line = lines.get(orderLine.id) ?? { orderLine, quantity: 0, externalReturnLineId: l.externalReturnLineId };
    line.quantity += l.quantity;
    lines.set(orderLine.id, line);
  }
  const pkgLines = await packageLinesOfOrderLines([...lines.keys()]);
  const rows = [...lines.values()].map((l) => {
    const own = pkgLines.filter((p) => p.orderLineId === l.orderLine.id);
    // Kiện đã giao chứa dòng; chưa có kiện giao thì lấy kiện đầu (sàn mở yêu cầu khi kiện còn trên đường, 25 §9).
    const pkg = own.find((p) => p.status === 'delivered') ?? own[0];
    return {
      orderLineId: l.orderLine.id,
      packageId: pkg?.packageId ?? null,
      variantId: l.orderLine.variantId,
      quantity: l.quantity,
      unitPrice: l.orderLine.unitPrice,
      unitCost: weightedUnitCost(own),
      externalLineId: l.externalReturnLineId,
    };
  });

  const notes: string[] = [];
  if (missing.length) notes.push(`Sàn có món không khớp dòng đơn: ${missing.join(', ')}`);
  // Khách trả hàng thì kiện phải đã giao: kiện còn trên đường nhảy tới `delivered` (25 §9); khác thì người dùng đối chiếu.
  if (r.kind === 'return') {
    for (const packageId of new Set(rows.flatMap((l) => (l.packageId ? [l.packageId] : [])))) {
      const outcome = await deliverForReturn(packageId, 'Sàn mở yêu cầu trả khi kiện chưa giao xong');
      if (outcome !== 'delivered') notes.push(`Kiện của dòng trả ở trạng thái ${outcome === 'jumped' ? 'chưa giao, đã chuyển sang Đã giao' : outcome}`);
    }
  }

  const created = await insertReturn({
    companyId: requireCompanyId('ingestMarketplaceReturn'),
    code: `YCT-${pad(await takeNextNumber('return_request'))}`,
    orderId,
    source: 'marketplace',
    shopId: r.shopId,
    externalReturnId: r.externalReturnId,
    status: 'requested',
    reason: r.reason ?? '',
    refundAmount: r.refundAmount ?? refundAmountOf(rows),
    needsAttention: notes.length > 0,
    attentionNote: notes.length ? notes.join('. ') : null,
    ...platformFields(r),
  });
  if (!created) return undefined;
  await insertReturnLines(rows.map((l) => ({ ...l, companyId: created.companyId, requestId: created.id })));
  return created;
}

/** Đưa yêu cầu tới trạng thái sàn báo nếu máy trạng thái cho phép; không cho thì bật Cần xử lý, giữ trạng thái app. */
async function syncExisting(row: ReturnRow, r: PlatformReturn): Promise<ReturnIngestOutcome> {
  const stale = row.externalUpdatedAt !== null && r.updatedAt.getTime() < row.externalUpdatedAt.getTime();
  if (stale) return 'unchanged';
  const fields = platformFields(r);
  const action = r.status ? syncAction(row.status, r.status) : null;
  if (action === 'conflict') {
    const note = `Sàn báo ${r.rawStatus} nhưng yêu cầu đang ${row.status}`;
    await updateReturnAt(row.id, row.version, row.status, { ...fields, needsAttention: true, attentionNote: note });
    return 'updated';
  }
  if (action) {
    await applyReturnStep(
      row,
      { action, to: r.status!, actorId: null, source: 'marketplace', reason: action === 'reject' ? (r.reason ?? r.rawStatus) : null },
      fields,
    );
    return 'updated';
  }
  const changed = row.rawMarketplaceStatus !== r.rawStatus || row.ofcStatus !== r.ofcStatus || row.disputeInProgress !== r.disputeInProgress;
  await updateReturnAt(row.id, row.version, row.status, fields);
  return changed ? 'updated' : 'unchanged';
}

/**
 * `inventory.return_inspected` (§11.2): phiếu kiểm hàng hoàn của yêu cầu đã ghi sổ thì đóng yêu cầu (`close`,
 * `inspected`), chia số bán lại về dòng, tính `resellCost`, hoàn tiền (`sales.return_refunded` trong `applyReturnStep`).
 * Phiếu không thuộc yêu cầu nào (kiện hoàn, kiện không khớp) thì bỏ qua.
 */
export async function onReturnInspected(event: {
  payload: { inspectionId: string; lines: readonly { variantId: string; resellable: number }[] };
}): Promise<void> {
  const row = await findReturnByInspection(event.payload.inspectionId);
  if (!row || row.status !== 'received') return;
  const lines = await findReturnLines([row.id]);
  const resellable = new Map<string, number>();
  for (const l of event.payload.lines) resellable.set(l.variantId, (resellable.get(l.variantId) ?? 0) + l.resellable);
  const { perLine, resellCost } = distributeResell(lines, resellable);
  for (const l of lines) await updateReturnLine(l.id, { resellQty: perLine.get(l.id) ?? 0 });
  await applyReturnStep(row, { action: 'close', to: 'closed', actorId: null, source: 'system' }, { resellCost });
}
