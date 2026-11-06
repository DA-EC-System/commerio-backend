import { z } from 'zod';
import { MAX_REASON } from '../domain/receipt.ts';
import { GOODS_RECEIPT_STATUSES } from '../domain/receipt-machine.ts';
import { MAX_LINES, MAX_QTY, MAX_UNIT_COST } from '../domain/request.ts';
import { PURCHASE_REQUEST_STATUSES } from '../domain/request-machine.ts';
import { SUPPLIER_RETURN_ACTIONS, SUPPLIER_RETURN_STATUSES } from '../domain/return-machine.ts';
import { StatusChangeSchema } from '../../../../shared/http/status-change.ts';

// Hợp đồng /purchasing (Documents/21 mục 16.2, FE `src/types/purchasing.ts`). Giới hạn theo mock FE.
// Id sai định dạng trả 404 ở service (như bản ghi không tồn tại, V6), nên tham số đường dẫn chỉ là chuỗi.

export const IdParams = z.object({ id: z.string() });
export const LineParams = z.object({ id: z.string(), lineId: z.string() });
export const ActionParams = z.object({ id: z.string(), action: z.string() });

const version = z.number('Thiếu version').int('Thiếu version').min(0, 'Thiếu version');
const page = {
  page: z.coerce.number('Trang là số nguyên từ 1').int('Trang là số nguyên từ 1').min(1, 'Trang là số nguyên từ 1').default(1),
  pageSize: z.coerce
    .number('Cỡ trang từ 1 đến 100')
    .int('Cỡ trang từ 1 đến 100')
    .min(1, 'Cỡ trang từ 1 đến 100')
    .max(100, 'Cỡ trang từ 1 đến 100')
    .default(20),
  search: z.string().trim().max(100, 'Từ khoá tối đa 100 ký tự').optional(),
};
const text = (max: number) => z.string(`Tối đa ${max} ký tự`).trim().max(max, `Tối đa ${max} ký tự`).default('');
const bool = (name: string) =>
  z
    .enum(['true', 'false'], `${name} là true hoặc false`)
    .transform((v) => v === 'true')
    .optional();
const qtyMessage = `Số lượng từ 1 đến ${MAX_QTY.toLocaleString('vi-VN')}`;
const quantity = z.number(qtyMessage).int(qtyMessage).min(1, qtyMessage).max(MAX_QTY, qtyMessage);

// ---------- Nhà cung cấp ----------

export const SupplierListQuery = z.object({ search: page.search, active: bool('active') });

export const SupplierInput = z
  .object({
    name: z.string('Nhập tên nhà cung cấp').trim().min(1, 'Nhập tên nhà cung cấp').max(150, 'Tối đa 150 ký tự'),
    phone: z
      .string('Số điện thoại không hợp lệ')
      .trim()
      .regex(/^(?:[0-9 +().-]{8,20})?$/, 'Số điện thoại không hợp lệ')
      .default(''),
    email: z
      .string('Email không hợp lệ')
      .trim()
      .refine((v) => v === '' || z.email().safeParse(v).success, 'Email không hợp lệ')
      .default(''),
    address: text(300),
    note: text(500),
    active: z.boolean('active là true hoặc false').default(true),
  })
  .meta({ id: 'SupplierInput' });

export const SupplierUpdateInput = SupplierInput.extend({ version }).meta({ id: 'SupplierUpdateInput' });

export const SupplierReportQuery = z
  .object({
    from: z.iso.date('Ngày bắt đầu dạng yyyy-mm-dd').optional(),
    to: z.iso.date('Ngày kết thúc dạng yyyy-mm-dd').optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'Ngày bắt đầu sau ngày kết thúc', path: ['from'] })
  .meta({ description: 'Ngày theo giờ Việt Nam, tính cả hai đầu; bỏ trống là không giới hạn' });

// ---------- Đề nghị nhập ----------

export const RequestListQuery = z.object({
  ...page,
  status: z.enum(PURCHASE_REQUEST_STATUSES, 'Trạng thái không hợp lệ').optional(),
  supplierId: z.uuid('Nhà cung cấp không hợp lệ').optional(),
});

const costMessage = 'Giá nhập không hợp lệ';
const RequestLineInput = z
  .object({
    variantId: z.uuid('Chọn sản phẩm').nullish(),
    newProduct: z
      .object({
        name: z.string('Nhập tên sản phẩm mới').trim().min(1, 'Nhập tên sản phẩm mới').max(120, 'Tối đa 120 ký tự'),
        categoryId: z.string('Chọn danh mục'),
      })
      .nullish(),
    quantity,
    unitCost: z.number(costMessage).int(costMessage).min(0, costMessage).max(MAX_UNIT_COST, costMessage),
  })
  .refine((l) => !l.variantId !== !l.newProduct, {
    message: 'Chọn sản phẩm có sẵn hoặc nhập sản phẩm mới',
    path: ['variantId'],
  });

export const PurchaseRequestInput = z
  .object({
    supplierId: z.string('Chọn nhà cung cấp'),
    note: text(500),
    lines: z
      .array(RequestLineInput, 'Thêm ít nhất một dòng')
      .min(1, 'Thêm ít nhất một dòng')
      .max(MAX_LINES, `Tối đa ${MAX_LINES} dòng`),
    sourceReturnId: z
      .string()
      .nullish()
      .meta({ description: 'Đề nghị bù hàng từ phiếu trả NCC đã `replaced`, chưa có đề nghị bù, cùng NCC (B4); chỉ dùng khi lập, sửa thì bỏ qua' }),
  })
  .meta({ id: 'PurchaseRequestInput' });

export const PurchaseRequestUpdateInput = PurchaseRequestInput.extend({ version }).meta({ id: 'PurchaseRequestUpdateInput' });

export const AddRequestLineInput = z
  .object({
    requestId: z.string().nullable(),
    supplierId: z.string().nullable(),
    variantId: z.uuid('Sản phẩm không còn bán'),
    quantity,
  })
  .refine((v) => v.requestId !== null || v.supplierId !== null, { message: 'Chọn nhà cung cấp', path: ['supplierId'] })
  .meta({ id: 'AddRequestLineInput', description: '`requestId` là nháp có sẵn; `null` thì lập nháp mới với `supplierId`' });

export const ExcludeLineInput = z
  .object({
    excluded: z.boolean('excluded là true hoặc false'),
    reason: z.string().trim().max(500, 'Lý do tối đa 500 ký tự').nullish().meta({ description: 'Bắt buộc khi `excluded: true`' }),
    version,
  })
  .meta({ id: 'ExcludeLineInput' });

export const RequestActionInput = z
  .object({
    version,
    reason: z.string('Lý do tối đa 500 ký tự').max(500, 'Lý do tối đa 500 ký tự').nullish(),
    expectedDeliveryDate: z.iso
      .date('Ngày giao dự kiến không hợp lệ')
      .nullish()
      .meta({ description: 'Bắt buộc khi `order`: ngày NCC hẹn giao, yyyy-mm-dd' }),
    supplierOrderCode: z
      .string()
      .trim()
      .max(100, 'Mã đơn NCC tối đa 100 ký tự')
      .nullish()
      .meta({ description: 'Chỉ dùng khi `order`: mã đơn bên NCC (tuỳ chọn)' }),
  })
  .meta({ id: 'PurchaseRequestActionInput' });

// ---------- Phiếu nhận ----------

export const ReceiptListQuery = z.object({
  ...page,
  status: z.enum(GOODS_RECEIPT_STATUSES, 'Trạng thái không hợp lệ').optional(),
  requestId: z.uuid('Đề nghị không hợp lệ').optional(),
});

const deliveryMode = z.enum(['waiting', 'left'], 'Chọn cách giao');

export const GoodsReceiptCreateInput = z
  .object({ requestId: z.string('Chọn đề nghị nhập'), deliveryMode, note: text(500) })
  .meta({ id: 'GoodsReceiptCreateInput' });

const countMessage = 'Nhập số nguyên từ 0';
const count = z.number(countMessage).int(countMessage).min(0, countMessage).max(MAX_QTY, countMessage);

export const GoodsReceiptLineInput = z
  .object({
    lineId: z.string('Thiếu dòng đề nghị').meta({ description: 'Id dòng đề nghị nhập' }),
    announced: count,
    accepted: count,
    defectKept: count,
    returnedOnSpot: count,
    reason: text(MAX_REASON),
  })
  .meta({ id: 'GoodsReceiptLineInput' });

export const GoodsReceiptUpdateInput = z
  .object({
    deliveryMode,
    note: text(500),
    attachmentIds: z
      .array(z.string(), 'Danh sách tệp không hợp lệ')
      .max(10, 'Tối đa 10 tệp')
      .default([])
      .meta({ description: 'Chưa hỗ trợ tới #114: khác rỗng trả 422 `errors.attachments`' }),
    lines: z.array(GoodsReceiptLineInput, 'Danh sách dòng không hợp lệ').max(MAX_LINES, `Tối đa ${MAX_LINES} dòng`).default([]),
    version,
  })
  .meta({ id: 'GoodsReceiptUpdateInput' });

export const ShortResolutionInput = z
  .object({
    kind: z.enum(['follow_up', 'close_short', 'supplier_wrong'], 'Chọn kết quả'),
    followUpNumber: z.string('Số phiếu giao bù không hợp lệ').max(30, 'Số phiếu giao bù không hợp lệ').nullish(),
    note: text(500),
    version,
  })
  .meta({ id: 'ShortResolutionInput', description: '`close_short` cần `purchasing.request.approve`' });

export const ReceiptActionInput = z
  .object({ version, reason: z.string('Lý do tối đa 500 ký tự').max(500, 'Lý do tối đa 500 ký tự').nullish() })
  .meta({ id: 'GoodsReceiptActionInput' });

// ---------- Response: Swagger và test integration parse body bằng chính các schema này (Documents/21 §1.1) ----------

const iso = z.iso.datetime();
const money = z.number().int().nullable().meta({ description: 'Số nguyên đồng; `null` khi không có quyền xem giá' });

export const Supplier = z
  .object({
    id: z.uuid(),
    name: z.string(),
    phone: z.string(),
    email: z.string(),
    address: z.string(),
    note: z.string(),
    active: z.boolean(),
    version: z.number().int(),
    createdAt: iso,
  })
  .strict()
  .meta({ id: 'Supplier' });

export const SupplierList = z.array(Supplier);

export const SupplierReport = z
  .object({
    supplierId: z.uuid(),
    supplierName: z.string(),
    receiptCount: z.number().int(),
    shortReceiptCount: z.number().int(),
    deliveredQty: z.number().int().meta({ description: 'Đạt + lỗi giữ + trả tại chỗ' }),
    defectQty: z.number().int().meta({ description: 'Lỗi giữ + trả tại chỗ' }),
    defectRate: z.number().nullable().meta({ description: '`defectQty / deliveredQty` (0–1), `null` khi chưa giao gì' }),
  })
  .strict()
  .meta({ id: 'SupplierReport' });

export const SupplierReportList = z.array(SupplierReport);

const status = z.enum(PURCHASE_REQUEST_STATUSES);

export const PurchaseRequestLine = z
  .object({
    id: z.uuid(),
    variantId: z.uuid().nullable(),
    sku: z.string().nullable(),
    productName: z.string(),
    attributesLabel: z.string(),
    newProduct: z.object({ name: z.string(), categoryId: z.string(), categoryName: z.string() }).strict().nullable(),
    quantity: z.number().int(),
    unitCost: money,
    excluded: z.boolean(),
    excludedReason: z.string().nullable(),
    received: z.number().int(),
    defective: z.number().int(),
    closedShort: z.number().int(),
    outstanding: z.number().int(),
  })
  .strict()
  .meta({ id: 'PurchaseRequestLine' });

const summaryShape = {
  id: z.uuid(),
  number: z.string(),
  status,
  supplier: z.object({ id: z.string(), name: z.string() }).strict(),
  note: z.string(),
  lineCount: z.number().int(),
  totalQty: z.number().int(),
  totalCost: money,
  outstanding: z.number().int(),
  supplierShort: z.boolean().meta({ description: 'Còn phiếu nhận ở Giao thiếu' }),
  createdBy: z.string(),
  createdById: z.string(),
  createdAt: iso,
  expectedDeliveryDate: z.iso.date().nullable().meta({ description: 'Ngày NCC hẹn giao, có từ lúc đặt' }),
  supplierOrderCode: z.string().nullable(),
  version: z.number().int(),
};

export const PurchaseRequestSummary = z.object(summaryShape).strict().meta({ id: 'PurchaseRequestSummary' });

export const PurchaseRequest = z
  .object({
    ...summaryShape,
    lines: z.array(PurchaseRequestLine),
    receipts: z.array(
      z
        .object({
          type: z.literal('goods_receipt'),
          id: z.uuid(),
          number: z.string(),
          status: z.enum(['counting', 'matched', 'short', 'resolved', 'cancelled']),
        })
        .strict(),
    ),
    sourceReturn: z.object({ type: z.literal('supplier_return'), id: z.uuid(), number: z.string() }).strict().nullable(),
    countingReceipts: z.number().int(),
    statusHistory: z.array(StatusChangeSchema),
  })
  .strict()
  .meta({ id: 'PurchaseRequest' });

export const PurchaseRequestPage = z
  .object({
    items: z.array(PurchaseRequestSummary),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  })
  .strict()
  .meta({ id: 'PurchaseRequestPage' });

const receiptSummaryShape = {
  id: z.uuid(),
  number: z.string(),
  status: z.enum(GOODS_RECEIPT_STATUSES),
  request: z.object({ id: z.uuid(), number: z.string() }).strict(),
  supplier: z.object({ id: z.string(), name: z.string() }).strict(),
  deliveryMode: z.enum(['waiting', 'left']),
  note: z.string(),
  totalAnnounced: z.number().int(),
  shortQty: z.number().int(),
  createdBy: z.string(),
  createdById: z.string(),
  createdAt: iso,
  postedBy: z.string().nullable(),
  postedAt: iso.nullable(),
  version: z.number().int(),
};

export const GoodsReceiptSummary = z.object(receiptSummaryShape).strict().meta({ id: 'GoodsReceiptSummary' });

export const GoodsReceiptLine = z
  .object({
    lineId: z.uuid().meta({ description: 'Id dòng đề nghị nhập' }),
    variantId: z.uuid(),
    sku: z.string(),
    productName: z.string(),
    attributesLabel: z.string(),
    outstanding: z.number().int().meta({ description: 'Còn chờ của dòng đề nghị lúc này' }),
    announced: z.number().int(),
    accepted: z.number().int(),
    defectKept: z.number().int(),
    returnedOnSpot: z.number().int(),
    short: z.number().int(),
    reason: z.string(),
  })
  .strict()
  .meta({ id: 'GoodsReceiptLine' });

export const GoodsReceipt = z
  .object({
    ...receiptSummaryShape,
    lines: z.array(GoodsReceiptLine),
    attachments: z.array(z.object({ fileId: z.string(), name: z.string(), url: z.string(), contentType: z.string() }).strict()),
    requestCreatedById: z.string().meta({ description: 'Người lập đề nghị: người ghi sổ phải khác' }),
    shortResolution: z
      .object({
        kind: z.enum(['follow_up', 'close_short', 'supplier_wrong']),
        followUp: z.object({ type: z.literal('goods_receipt'), id: z.uuid(), number: z.string() }).strict().nullable(),
        note: z.string(),
        by: z.string(),
        at: iso,
      })
      .strict()
      .nullable(),
    followUps: z.array(z.object({ type: z.literal('supplier_return'), id: z.uuid(), number: z.string() }).strict()),
    statusHistory: z.array(StatusChangeSchema),
  })
  .strict()
  .meta({ id: 'GoodsReceipt' });

export const GoodsReceiptPage = z
  .object({
    items: z.array(GoodsReceiptSummary),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  })
  .strict()
  .meta({ id: 'GoodsReceiptPage' });

// ---------- Phiếu trả NCC (§16.2, §16.3; #210) ----------

const returnStatus = z.enum(SUPPLIER_RETURN_STATUSES);
export const ReturnActionParams = z.object({ id: z.string(), action: z.enum(SUPPLIER_RETURN_ACTIONS, 'Thao tác không có') });

export const SupplierReturnListQuery = z.object({
  ...page,
  status: returnStatus.optional(),
  supplierId: z.uuid('Nhà cung cấp không hợp lệ').optional(),
});

export const SupplierReturnInput = z
  .object({
    supplierId: z.uuid('Nhà cung cấp không hợp lệ').nullable(),
    note: text(500),
    lines: z
      .array(
        z.object({
          variantId: z.uuid('Chọn sản phẩm'),
          quantity: z.number('Số lượng là số nguyên từ 1').int('Số lượng là số nguyên từ 1').max(MAX_QTY, 'Số lượng quá lớn'),
        }),
      )
      .max(MAX_LINES, `Tối đa ${MAX_LINES} dòng`),
  })
  .meta({ id: 'SupplierReturnInput' });
export const SupplierReturnUpdateInput = SupplierReturnInput.extend({ version }).meta({ id: 'SupplierReturnUpdateInput' });

export const SupplierReturnActionInput = z
  .object({
    version,
    reason: z.string().trim().max(MAX_REASON, `Lý do tối đa ${MAX_REASON} ký tự`).nullish(),
    refundAmount: z.number('Số tiền là số nguyên đồng').int('Số tiền là số nguyên đồng').optional(),
    cancelDecision: z.enum(['restock', 'write_off'], 'Chọn nhập lại tồn hoặc xuất huỷ').optional(),
  })
  .meta({ id: 'SupplierReturnActionInput' });

const ReturnDocRef = z.object({ type: z.string(), id: z.uuid(), number: z.string() });

export const SupplierReturnSummary = z
  .object({
    id: z.uuid(),
    number: z.string(),
    status: returnStatus,
    supplier: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    source: ReturnDocRef.nullable(),
    note: z.string(),
    totalQty: z.int(),
    createdBy: z.string(),
    createdById: z.string(),
    createdAt: iso,
    sentAt: iso.nullable(),
    version: z.int(),
  })
  .strict()
  .meta({ id: 'SupplierReturnSummary' });

export const SupplierReturn = SupplierReturnSummary.extend({
  lines: z.array(
    z
      .object({
        variantId: z.uuid(),
        sku: z.string(),
        productName: z.string(),
        attributesLabel: z.string(),
        quantity: z.int(),
        quarantine: z.int().meta({ description: 'Chờ xử lý hiện có của biến thể' }),
        unitCost: z.int().nullable(),
      })
      .strict(),
  ),
  sentBy: z.string().nullable(),
  sentById: z.uuid().nullable(),
  refundAmount: z.int().nullable(),
  replacementRequest: ReturnDocRef.nullable(),
  cancelDecision: z.enum(['restock', 'write_off']).nullable(),
  followUps: z.array(ReturnDocRef),
  statusHistory: z.array(StatusChangeSchema),
})
  .strict()
  .meta({ id: 'SupplierReturn' });

export const SupplierReturnPage = z
  .object({ items: z.array(SupplierReturnSummary), total: z.int(), page: z.int(), pageSize: z.int() })
  .meta({ id: 'SupplierReturnPage' });
