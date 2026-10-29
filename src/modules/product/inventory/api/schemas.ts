import { z } from 'zod';

// Hợp đồng /inventory (Documents/21 mục 15.1, 15.2). Phiếu kho có duyệt (mục 15.3) làm ở issue vòng đời B3.
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

export const StockMove = z
  .object({
    id: z.string(),
    area: z.enum(['on_hand', 'quarantine']),
    qtyChange: z.number().int(),
    balanceAfter: z.number().int(),
    document: z.object({ id: z.string(), type: z.enum(['goods_receipt', 'stock_document', 'supplier_return']) }),
    unitCost: money,
    doneAt: z.string(),
    doneBy: z.string().nullable(),
  })
  .meta({ id: 'StockMove' });

export const StockDetail = z.object({ level: StockLevel, moves: z.array(StockMove) }).meta({ id: 'StockDetail' });
