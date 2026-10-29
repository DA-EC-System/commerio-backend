// Dựng phiếu nhận trả FE (Documents/21 mục 16.2, FE `src/types/purchasing.ts` `GoodsReceipt`). Phiếu nhận không có giá,
// nên kho không thấy giá vốn qua đây.
import { getStatusHistory } from '../../../core/index.ts';
import { getVariants } from '../../catalog/index.ts';
import { fromDbMode } from '../domain/receipt.ts';
import { outstanding } from '../domain/request.ts';
import { findReceipt, type ListedReceipt, type ReceiptLineRow, receiptLines, type ReceiptRow } from '../repository/receipts.ts';
import { findLines, findRequest } from '../repository/requests.ts';
import { findSupplier } from '../repository/suppliers.ts';
import { attributesLabel, namesOf } from './request-views.ts';

interface Refs {
  request: { id: string; number: string };
  supplier: { id: string; name: string };
}

function summaryOf(row: ReceiptRow, refs: Refs, lines: readonly ReceiptLineRow[], names: Map<string, string>) {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    ...refs,
    deliveryMode: fromDbMode(row.deliveryMode),
    note: row.note ?? '',
    totalAnnounced: lines.reduce((s, l) => s + l.declaredQty, 0),
    shortQty: lines.reduce((s, l) => s + l.shortageQty, 0),
    createdBy: row.createdBy ? (names.get(row.createdBy) ?? '') : '',
    createdById: row.createdBy ?? '',
    createdAt: row.createdAt.toISOString(),
    postedBy: row.postedBy ? (names.get(row.postedBy) ?? '') : null,
    postedAt: row.postedAt?.toISOString() ?? null,
    version: row.version,
  };
}

/** Bản tóm tắt cho danh sách; `rows` đã kèm số đề nghị và NCC. */
export async function toReceiptSummaries(rows: readonly ListedReceipt[]) {
  const lines = rows.length ? Map.groupBy(await receiptLines(rows.map((r) => r.id)), (l) => l.receiptId) : new Map();
  const names = await namesOf(rows.flatMap((r) => [r.createdBy, r.postedBy]));
  return rows.map((r) =>
    summaryOf(
      r,
      { request: { id: r.requestId, number: r.requestNumber }, supplier: { id: r.supplierId ?? '', name: r.supplierName ?? '' } },
      lines.get(r.id) ?? [],
      names,
    ),
  );
}

/** Bản chi tiết: dòng kèm còn chờ hiện tại của dòng đề nghị, kết quả giao thiếu, lịch sử trạng thái. */
export async function toReceiptDetail(row: ReceiptRow) {
  const request = (await findRequest(row.requestId))!;
  const supplier = request.supplierId ? await findSupplier(request.supplierId) : undefined;
  const lines = await receiptLines([row.id]);
  const requestLines = new Map((await findLines([row.requestId])).map((l) => [l.id, l]));
  const variants = new Map((await getVariants(lines.map((l) => l.variantId))).map((v) => [v.id, v]));
  const followUp = row.followUpReceiptId ? await findReceipt(row.followUpReceiptId) : undefined;
  const names = await namesOf([row.createdBy, row.postedBy, row.resolvedBy]);
  const history = await getStatusHistory('goods_receipts', row.id);
  const refs = { request: { id: request.id, number: request.number }, supplier: { id: supplier?.id ?? '', name: supplier?.name ?? '' } };
  return {
    ...summaryOf(row, refs, lines, names),
    lines: lines.map((l) => {
      const v = variants.get(l.variantId);
      return {
        lineId: l.requestLineId,
        variantId: l.variantId,
        sku: v?.sku ?? '',
        productName: v?.productName ?? '',
        attributesLabel: v ? attributesLabel(v) : '',
        outstanding: outstanding(requestLines.get(l.requestLineId)!),
        announced: l.declaredQty,
        accepted: l.acceptedQty,
        defectKept: l.defectiveQty,
        returnedOnSpot: l.returnedOnSpotQty,
        short: l.shortageQty,
        reason: l.reason ?? '',
      };
    }),
    // Tệp đính kèm làm sau #114 (spec #109 PR D).
    attachments: [] as { fileId: string; name: string; url: string; contentType: string }[],
    requestCreatedById: request.createdBy ?? '',
    shortResolution: row.shortResolution
      ? {
          kind: row.shortResolution,
          followUp: followUp ? { type: 'goods_receipt' as const, id: followUp.id, number: followUp.number } : null,
          note: row.resolutionNote ?? '',
          by: row.resolvedBy ? (names.get(row.resolvedBy) ?? '') : '',
          at: row.resolvedAt!.toISOString(),
        }
      : null,
    // Phiếu trả NCC sinh từ hàng lỗi giữ lại: lập khi ghi sổ (spec #109 PR B).
    followUps: [] as { type: 'supplier_return'; id: string; number: string }[],
    statusHistory: history.map((h) => ({ ...h, at: h.at.toISOString() })),
  };
}

export type GoodsReceiptView = Awaited<ReturnType<typeof toReceiptDetail>>;
