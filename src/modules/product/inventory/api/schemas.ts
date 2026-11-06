import { z } from 'zod';
import { StatusChangeSchema } from '../../../../shared/http/status-change.ts';
import { DOC_ACTIONS, DOC_STATUSES, DOC_TYPES, MANUAL_DOC_TYPES } from '../domain/stock-document.ts';

// Hợp đồng /inventory (Documents/21 mục 15.1, 15.2). Phiếu kho có duyệt (mục 15.3, #208): kiểu theo FE `src/types/inventory.ts`.
// Giới hạn theo mock FE (V24): ngưỡng 0…1.000.000; trang 1…, cỡ trang 1…100 (A3).

const MAX_QTY = 1_000_000;

/** `variantId` sai định dạng trả 404 ở service (như bản ghi không tồn tại, V6), nên ở đây chỉ là chuỗi. */
export const VariantParams = z.object({ variantId: z.string() });

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

export const StockListQuery = z.object({
  ...page,
  categoryId: z.uuid('Danh mục không hợp lệ').optional(),
  belowMin: z
    .enum(['true', 'false'], 'belowMin là true hoặc false')
    .transform((v) => v === 'true')
    .optional(),
  quarantine: z
    .enum(['true', 'false'], 'quarantine là true hoặc false')
    .transform((v) => v === 'true')
    .optional(),
  negative: z
    .enum(['true', 'false'], 'negative là true hoặc false')
    .transform((v) => v === 'true')
    .optional(),
});

export const ReorderRuleBody = z
  .object({
    minQty: z
      .number('Ngưỡng là số nguyên không âm')
      .int('Ngưỡng là số nguyên không âm')
      .min(0, 'Ngưỡng là số nguyên không âm')
      .max(MAX_QTY, 'Ngưỡng là số nguyên không âm')
      .nullable(),
    version,
  })
  .meta({ id: 'ReorderRuleRequest', description: '`minQty: null` là bỏ ngưỡng; `version` là `reorderVersion` (0 khi chưa có)' });

// ---------- Response (chỉ để khai Swagger; dữ liệu dựng ở service) ----------

const money = z.number().int().nullable().meta({ description: 'Số nguyên đồng; `null` khi không có quyền xem' });

export const StockLevel = z
  .object({
    variantId: z.string(),
    productId: z.string(),
    productName: z.string(),
    sku: z.string(),
    attributesLabel: z.string().meta({ example: 'Đỏ / M' }),
    category: z.object({ id: z.string(), name: z.string() }),
    onHand: z.number().int(),
    reserved: z.number().int(),
    locked: z.number().int(),
    available: z.number().int(),
    quarantine: z.number().int(),
    incoming: z.number().int(),
    shortage: z.number().int(),
    negative: z.boolean(),
    drift: z.boolean().meta({ description: 'Lệch tồn với sàn; luôn false tới #206 phần 2b' }),
    minQty: z.number().int().nullable(),
    belowMin: z.boolean().meta({ description: 'Có thể bán + đang về − còn thiếu cho đơn ≤ ngưỡng; SKU ngừng bán, lưu trữ thì false' }),
    state: z.enum(['in_stock', 'low', 'out']).meta({ description: 'Hết hàng khi có thể bán ≤ 0, sắp hết khi 0 < có thể bán ≤ ngưỡng' }),
    reorderVersion: z.number().int(),
    avgCost: money,
    stockValue: money,
  })
  .meta({ id: 'StockLevel' });

export const StockPage = z
  .object({
    items: z.array(StockLevel),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
    summary: z.object({
      variantCount: z.number().int(),
      belowMinCount: z.number().int(),
      quarantineCount: z.number().int(),
      negativeCount: z.number().int(),
      totalValue: money,
    }),
  })
  .meta({ id: 'StockPage' });

export const StockMove = z
  .object({
    id: z.string(),
    qtyChange: z.number().int(),
    area: z.enum(['stock', 'quarantine']).meta({ description: 'Ngăn tồn thực (`stock`) hoặc chờ xử lý' }),
    onHandAfter: z.number().int().meta({ description: 'Số của ngăn đó sau biến động' }),
    document: z.object({
      id: z.string(),
      number: z.string().meta({ example: 'NH-000001' }),
      type: z.enum([
        'stocktake',
        'write_off',
        'to_quarantine',
        'return_inspection',
        'shipment',
        'shipment_reversal',
        'goods_receipt',
        'supplier_return',
      ]),
      kind: z.enum(['manual', 'purchase', 'order', 'auto']).meta({
        description: 'Suy ra từ loại chứng từ: người lập tay, mua hàng, đơn hàng, hệ thống tự sinh',
      }),
    }),
    unitCost: money,
    doneAt: z.string(),
    doneBy: z.string().nullable().meta({ description: 'Tên người ghi sổ; `null` khi hệ thống hoặc sàn ghi' }),
  })
  .meta({ id: 'StockMove' });

export const StockDetail = z.object({ level: StockLevel, moves: z.array(StockMove) }).meta({ id: 'StockDetail' });

// ---------- Phiếu kho có duyệt (#208) ----------

const area = z.enum(['stock', 'quarantine'], 'Khu vực là stock hoặc quarantine');
const docType = z.enum(DOC_TYPES);
const docStatus = z.enum(DOC_STATUSES);

export const DocParams = z.object({ id: z.string() });
export const DocActionParams = z.object({ id: z.string(), action: z.enum(DOC_ACTIONS, 'Thao tác không có') });

export const DocListQuery = z.object({
  page: page.page,
  pageSize: page.pageSize,
  search: page.search,
  type: docType.optional(),
  status: docStatus.optional(),
});

/** Số trên dòng: số nguyên, kiểm khoảng ở service để lỗi theo dòng như mock FE. */
const qty = z.number('Số lượng là số nguyên').int('Số lượng là số nguyên').max(MAX_QTY, 'Số lượng tối đa 1.000.000').optional();
const DocLineInput = z.object({
  variantId: z.uuid('Biến thể không hợp lệ'),
  quantity: qty,
  counted: qty,
  scanned: qty,
  resell: qty,
  damaged: qty,
  toSupplier: qty,
});

export const DocCreateBody = z.object({
  type: z.enum(MANUAL_DOC_TYPES, 'Loại phiếu là stocktake, write_off hoặc to_quarantine'),
  area: area.optional(),
  note: z.string().max(500, 'Ghi chú tối đa 500 ký tự').default(''),
  lines: z.array(DocLineInput).max(200, 'Tối đa 200 dòng một phiếu'),
});
export const DocUpdateBody = z.object({
  area: area.optional(),
  note: z.string().max(500, 'Ghi chú tối đa 500 ký tự').default(''),
  lines: z.array(DocLineInput).max(200, 'Tối đa 200 dòng một phiếu'),
  version,
});
export const DocActionBody = z.object({ version, reason: z.string().trim().max(500, 'Lý do tối đa 500 ký tự').optional() });
export const DocDecideBody = z.object({
  decision: z.enum(['restock', 'supplier_return'], 'Chọn nhập lại tồn hoặc trả NCC'),
  version,
});

const DocRef = z
  .object({
    type: z.enum(['order', 'package', 'return_request', 'stock_document', 'goods_receipt', 'supplier_return', 'purchase_request']),
    id: z.uuid(),
    number: z.string(),
  })
  .meta({ id: 'DocRef' });

export const StockDocSummary = z
  .object({
    id: z.uuid(),
    number: z.string(),
    type: docType,
    kind: z.enum(['manual', 'purchase', 'order', 'auto']),
    status: docStatus,
    area: area.nullable(),
    note: z.string(),
    source: DocRef.nullable(),
    claimFlag: z.boolean(),
    lineCount: z.int(),
    totalQty: z.int(),
    createdBy: z.string(),
    createdById: z.string(),
    createdAt: z.iso.datetime(),
    postedBy: z.string().nullable(),
    postedAt: z.iso.datetime().nullable(),
    version: z.int(),
  })
  .meta({ id: 'StockDocSummary' });

const StockDocLine = z.object({
  variantId: z.uuid(),
  sku: z.string(),
  productName: z.string(),
  attributesLabel: z.string(),
  quantity: z.int().meta({ description: 'Kiểm kê: Δ = đếm − sổ; kiểm hàng về: số quét; phiếu khác: số lượng' }),
  bookQty: z.int().optional(),
  counted: z.int().optional(),
  expected: z.int().optional(),
  resell: z.int().optional(),
  damaged: z.int().optional(),
  toSupplier: z.int().optional(),
  locked: z.int().optional().meta({ description: 'Phiếu giảm đang chờ duyệt: số đang tạm khoá' }),
  unitCost: z.int().nullable().meta({ description: 'Giá vốn chốt lúc ghi sổ; `null` khi chưa ghi sổ hoặc thiếu `inventory.cost.view`' }),
});

export const StockDoc = StockDocSummary.extend({
  lines: z.array(StockDocLine),
  statusHistory: z.array(StatusChangeSchema),
  followUps: z.array(DocRef),
  rejectDecision: z.enum(['restock', 'supplier_return']).nullable(),
  needsDecision: z.boolean(),
}).meta({ id: 'StockDoc' });

export const StockDocPage = z
  .object({ items: z.array(StockDocSummary), total: z.int(), page: z.int(), pageSize: z.int() })
  .meta({ id: 'StockDocPage' });
