// Schema Zod của route yêu cầu trả (Documents/21 §20, §20.1). Tên `.meta({ id })` trùng kiểu FE `src/types/returns.ts`.
import { z } from 'zod';
import { StatusChangeSchema } from '../../../../shared/http/status-change.ts';
import { RETURN_STATUSES } from '../domain/return.ts';

const ReturnStatusSchema = z.enum(RETURN_STATUSES);
const CloseResult = z.enum(['inspected', 'no_show', 'buyer_cancelled']);
const UserRef = z.object({ id: z.uuid(), name: z.string() });

export const ReturnListQuery = z.object({
  status: ReturnStatusSchema.optional(),
  source: z.enum(['marketplace', 'manual']).optional(),
  orderId: z.uuid('Mã đơn không hợp lệ').optional(),
  search: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const ReturnParams = z.object({ id: z.string() });

export const ReturnRequestSummary = z
  .object({
    id: z.uuid(),
    code: z.string(),
    order: z.object({ id: z.uuid(), code: z.string() }),
    source: z.enum(['marketplace', 'inbox', 'manual']),
    shopId: z.uuid().nullable(),
    shopName: z.string().nullable(),
    customerName: z.string().nullable(),
    status: ReturnStatusSchema,
    closeResult: CloseResult.nullable(),
    rawMarketplaceStatus: z.string().nullable().meta({ description: 'Trạng thái gốc của sàn, chỉ để hiện (R11)' }),
    totalQty: z.number().int(),
    refundAmount: z.number().int(),
    createdAt: z.iso.datetime(),
    version: z.number().int(),
  })
  .strict()
  .meta({ id: 'ReturnRequestSummary' });

const STATUS_COUNTS = Object.fromEntries(RETURN_STATUSES.map((s) => [s, z.number().int()])) as Record<(typeof RETURN_STATUSES)[number], z.ZodNumber>;

export const ReturnListResponse = z
  .object({
    items: z.array(ReturnRequestSummary),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
    counts: z.object({ ...STATUS_COUNTS, unmatched: z.number().int() }).strict(),
  })
  .strict()
  .meta({ id: 'ReturnListResponse' });

export const ReturnRequest = ReturnRequestSummary.extend({
  reason: z.string(),
  lines: z.array(
    z
      .object({
        variantId: z.uuid().nullable().meta({ description: 'null khi dòng đơn chưa ghép SKU' }),
        sku: z.string().nullable(),
        productName: z.string(),
        attributesLabel: z.string(),
        quantity: z.number().int(),
        unitPrice: z.number().int(),
        packageId: z.uuid().nullable(),
        packageCode: z.string().nullable(),
      })
      .strict(),
  ),
  returnTrackingCode: z.string().nullable(),
  inspection: z.object({ type: z.literal('stock_document'), id: z.uuid(), number: z.string() }).strict().nullable(),
  receivedAt: z.iso.datetime().nullable(),
  receivedBy: UserRef.nullable(),
  money: z
    .object({
      refundAmount: z.number().int(),
      refunded: z.boolean(),
      resellQty: z.number().int().nullable(),
      resellCost: z.number().int().nullable().meta({ description: 'null khi chưa kiểm hàng hoàn hoặc thiếu `inventory.cost.view`' }),
    })
    .strict(),
  needsAttention: z.boolean(),
  attentionNote: z.string().nullable(),
  statusHistory: z.array(StatusChangeSchema),
  platform: z
    .object({
      reverseStatus: z.string(),
      ofcStatus: z.string().nullable(),
      disputeInProgress: z.boolean(),
      returnTo: z.enum(['warehouse', 'merchant']).nullable(),
    })
    .strict()
    .nullable(),
  rejectReason: z.object({ id: z.string(), label: z.string() }).strict().nullable(),
  attachments: z.array(z.object({ id: z.uuid() })).meta({ description: 'Chưa lưu tệp đính kèm (#212): luôn rỗng' }),
})
  .strict()
  .meta({ id: 'ReturnRequest' });

export const RETURN_ACTIONS = ['accept', 'reject', 'refund-only', 'platform-reopen', 'platform-refund', 'no-show'] as const;
export const ReturnActionParams = z.object({ id: z.string(), action: z.enum(RETURN_ACTIONS) });

export const ReturnActionBody = z.object({
  version: z.number().int().min(0),
  reason: z.string().trim().max(500).optional(),
  reasonId: z.string().trim().min(1).optional(),
  comment: z.string().trim().max(500).optional(),
  attachmentIds: z.array(z.uuid()).max(10).optional(),
});

/** Số kho quét từng món (§15.3): số nguyên ≥ 0, `variantId` không lặp. */
export const ScanLines = z.array(z.object({ variantId: z.string().min(1), quantity: z.number().int('Số lượng phải là số nguyên').min(0, 'Số lượng không âm') })).superRefine((lines, ctx) => {
  const seen = new Set<string>();
  lines.forEach((l, i) => {
    if (seen.has(l.variantId)) ctx.addIssue({ code: 'custom', path: [i, 'variantId'], message: 'Biến thể bị lặp' });
    seen.add(l.variantId);
  });
});

export const ReceiveReturnBody = z.object({
  code: z.string().trim().min(1, 'Quét mã yêu cầu, mã vận đơn hoặc mã đơn').max(100),
  note: z.string().trim().max(500).optional(),
  lines: ScanLines.optional().meta({ description: 'Tuỳ chọn trong giai đoạn chuyển tiếp (FE#212); không gửi thì coi như quét đủ' }),
});

export const UnmatchedParcel = z
  .object({
    id: z.uuid(),
    code: z.string(),
    scannedCode: z.string(),
    note: z.string(),
    status: z.enum(['open', 'attached', 'dismissed']),
    receivedAt: z.iso.datetime(),
    receivedBy: UserRef.nullable(),
    returnRequest: z.object({ id: z.uuid(), code: z.string() }).strict().nullable(),
    resolvedAt: z.iso.datetime().nullable(),
    resolvedBy: UserRef.nullable(),
    resolution: z.string().nullable(),
    lines: z.array(z.object({ variantId: z.uuid(), quantity: z.number().int() }).strict()),
    inspection: z.object({ documentId: z.uuid(), number: z.string() }).strict().nullable(),
    version: z.number().int(),
  })
  .strict()
  .meta({ id: 'UnmatchedParcel' });

export const ReceiveResult = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('matched'), request: ReturnRequest }).strict(),
    z.object({ kind: z.literal('unmatched'), parcel: UnmatchedParcel }).strict(),
  ])
  .meta({ id: 'ReceiveResult' });

export const UnmatchedQuery = z.object({ status: z.enum(['open', 'attached', 'dismissed']).optional() });
export const UnmatchedList = z.array(UnmatchedParcel);
export const AttachBody = z.object({ version: z.number().int().min(0), returnRequestId: z.string().min(1) });
export const DismissBody = z.object({ version: z.number().int().min(0), reason: z.string().trim().min(1, 'Cần ghi lý do').max(500) });

export const ReasonsQuery = z.object({ action: z.enum(['reject', 'refuse-refund']).default('reject') });
export const ReturnReasonList = z
  .object({ items: z.array(z.object({ id: z.string(), label: z.string(), requiresImage: z.boolean() }).strict()) })
  .strict()
  .meta({ id: 'ReturnReasonList' });
export const PlatformHistoryList = z
  .object({ items: z.array(z.object({ at: z.string(), reverseStatus: z.string(), ofcStatus: z.string().nullable(), note: z.string().nullable() }).strict()) })
  .strict()
  .meta({ id: 'PlatformHistoryList' });
