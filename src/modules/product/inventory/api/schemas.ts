import { z } from 'zod';

// Hợp đồng /inventory (Documents/21 7.1, 7.2). Giới hạn theo mock FE (V24, plan #16 A7): số lượng 1…1.000.000,
// giá nhập nguyên đồng 0…10 tỷ, tối đa 200 dòng, ghi chú 500 ký tự; trang 1…, cỡ trang 1…100 (A3).

const MAX_QTY = 1_000_000;
const MAX_PRICE = 10_000_000_000;

/** `id` sai định dạng trả 404 ở service (như bản ghi không tồn tại, V6), nên ở đây chỉ là chuỗi. */
export const IdParams = z.object({ id: z.string() });
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
});

export const DocListQuery = z.object({
  ...page,
  type: z.enum(['receipt', 'issue'], 'Loại phiếu là receipt hoặc issue').optional(),
  status: z.enum(['draft', 'done', 'cancelled'], 'Trạng thái là draft, done hoặc cancelled').optional(),
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

const qtyMessage = 'Số lượng là số nguyên từ 1';
const priceMessage = 'Giá nhập là số nguyên đồng, không âm';
const DocLine = z.object({
  variantId: z.string('Chọn biến thể'),
  quantity: z.number(qtyMessage).int(qtyMessage).min(1, qtyMessage).max(MAX_QTY, qtyMessage),
  unitCost: z.number(priceMessage).int(priceMessage).min(0, priceMessage).max(MAX_PRICE, priceMessage).optional(),
});
const docFields = {
  note: z.string('Ghi chú là chuỗi').trim().max(500, 'Ghi chú tối đa 500 ký tự').default(''),
  lines: z.array(DocLine, 'Thêm ít nhất một dòng').min(1, 'Thêm ít nhất một dòng').max(200, 'Tối đa 200 dòng một phiếu'),
};

/** Luật theo loại phiếu (giá nhập, lý do xuất, dòng trùng) và biến thể kiểm ở service, gộp một lượt 422. */
export const CreateDocBody = z
  .object({ type: z.enum(['receipt', 'issue'], 'Chọn phiếu nhập hoặc phiếu xuất'), ...docFields })
  .meta({ id: 'CreateStockDocRequest' });

export const UpdateDocBody = z.object({ ...docFields, version }).meta({ id: 'UpdateStockDocRequest' });
export const VersionBody = z.object({ version }).meta({ id: 'VersionRequest' });

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
    available: z.number().int(),
    minQty: z.number().int().nullable(),
    belowMin: z.boolean(),
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
    summary: z.object({ variantCount: z.number().int(), belowMinCount: z.number().int(), totalValue: money }),
  })
  .meta({ id: 'StockPage' });

const docKind = z.enum(['purchase', 'manual', 'delivery_return', 'order']);

export const StockMove = z
  .object({
    id: z.string(),
    qtyChange: z.number().int(),
    onHandAfter: z.number().int(),
    document: z.object({ id: z.string(), number: z.string(), type: z.enum(['receipt', 'issue']), kind: docKind }),
    unitCost: money,
    doneAt: z.string(),
    doneBy: z.string().nullable(),
  })
  .meta({ id: 'StockMove' });

export const StockDetail = z.object({ level: StockLevel, moves: z.array(StockMove) }).meta({ id: 'StockDetail' });

export const StockDocSummary = z
  .object({
    id: z.string(),
    number: z.string().meta({ example: 'PN-000001' }),
    type: z.enum(['receipt', 'issue']),
    kind: docKind,
    status: z.enum(['draft', 'done', 'cancelled']),
    note: z.string(),
    reference: z.string().nullable(),
    lineCount: z.number().int(),
    totalQty: z.number().int(),
    createdBy: z.string().nullable(),
    createdAt: z.string(),
    postedBy: z.string().nullable(),
    postedAt: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'StockDocSummary' });

export const StockDoc = StockDocSummary.extend({
  lines: z.array(
    z.object({
      variantId: z.string(),
      sku: z.string(),
      productName: z.string(),
      attributesLabel: z.string(),
      quantity: z.number().int(),
      unitCost: money,
    }),
  ),
}).meta({ id: 'StockDoc' });

export const StockDocPage = z
  .object({ items: z.array(StockDocSummary), total: z.number().int(), page: z.number().int(), pageSize: z.number().int() })
  .meta({ id: 'StockDocPage' });
