import { z } from 'zod';
import { BUSINESS_ACTIONS, BUSINESS_STATUSES } from '../domain/business-status.ts';
import { MAIN_LABELS, type MainLabel, MISSING_FIELDS, PRESENCES } from '../domain/labels.ts';
import { BulkRowInput } from '../domain/bulk-row.ts';
import { skuPatternError, valueCode } from '../domain/sku.ts';
import { MAX_PRODUCT_IMAGES } from '../service/product-images.ts';

// Giới hạn theo mock FE (Documents/21 V24): tên danh mục 60, thuộc tính 40, giá trị 40, sản phẩm 200, mô tả 5000.

const name = (what: string, max: number) =>
  z
    .string(`Nhập tên ${what}`)
    .trim()
    .min(1, `Nhập tên ${what}`)
    .max(max, `Tên ${what} tối đa ${max} ký tự`);

const version = z.number('Thiếu version').int().positive();

/** `id` sai định dạng trả 404 ở service (như bản ghi không tồn tại), nên ở đây chỉ là chuỗi. */
export const IdParams = z.object({ id: z.string() });
export const VariantParams = z.object({ id: z.string(), variantId: z.string() });
export const VersionQuery = z.object({ version: z.coerce.number('Thiếu version').int().positive('Thiếu version') });

// ---------- Danh mục ----------

const skuPattern = z
  .string('Nhập quy tắc SKU')
  .trim()
  .superRefine((value, ctx) => {
    const message = skuPatternError(value);
    if (message) ctx.addIssue({ code: 'custom', message });
  })
  .meta({ example: 'AO-{SEQ:4}-{VAL}', description: 'Quy tắc SKU (Documents/21 5.1, mục 9)' });

const optionalInt = (max: number, min = 0) =>
  z
    .number('Nhập số nguyên')
    .int('Nhập số nguyên')
    .min(min, `Từ ${min} trở lên`)
    .max(max, `Tối đa ${max}`)
    .nullable();

/** Cấu hình gợi ý khi sửa hàng loạt (#242). Gửi thì thay cả năm giá trị; `null` là chưa đặt. */
export const SuggestConfig = z
  .strictObject({
    marginCoefficient: z
      .number('Nhập hệ số lãi')
      .min(1, 'Hệ số lãi từ 1 trở lên (1,4 là lãi 40%)')
      .max(100, 'Hệ số lãi tối đa 100')
      .refine((v) => Math.round(v * 100) / 100 === v, 'Hệ số lãi tối đa hai chữ số thập phân')
      .nullable()
      .meta({ description: 'Giá muốn bán gợi ý = giá nhập × hệ số' }),
    priceRounding: optionalInt(1_000_000, 1).meta({ description: 'Bước làm tròn lên của giá muốn bán, đồng (vd 1000)' }),
    reorderLeadDays: optionalInt(365).meta({ description: 'Số ngày chờ hàng về, để gợi ý ngưỡng tồn' }),
    reorderSafetyQty: optionalInt(1_000_000).meta({ description: 'Tồn an toàn cộng vào ngưỡng tồn gợi ý' }),
    reorderDefaultQty: optionalInt(1_000_000).meta({ description: 'Ngưỡng tồn gợi ý cho SKU chưa có lịch sử bán' }),
  })
  .meta({ id: 'CategorySuggestConfig' });

export const CategoryBody = z
  .object({
    name: name('danh mục', 60),
    skuPattern,
    suggest: SuggestConfig.optional().meta({ description: 'Bỏ trống thì giữ cấu hình đang lưu (tạo mới: chưa đặt)' }),
  })
  .meta({ id: 'CategoryRequest' });
export const UpdateCategoryBody = CategoryBody.extend({ version }).meta({ id: 'UpdateCategoryRequest' });

// ---------- Thuộc tính ----------

const CODE = /^[A-Z0-9]{1,6}$/;

/**
 * Mã bỏ trống thì sinh từ giá trị (bảng 9.2, V21). Lỗi ở `values.<i>.code`, giá trị trùng ở `values`
 * (khớp mock FE `validateAttribute`).
 */
const values = z
  .array(
    z.object({
      id: z.string().optional(),
      value: z.string('Nhập giá trị').trim().min(1, 'Nhập giá trị').max(40, 'Mỗi giá trị tối đa 40 ký tự'),
      code: z.string().optional(),
    }),
    'Thêm ít nhất một giá trị',
  )
  .min(1, 'Thêm ít nhất một giá trị')
  .transform((items) => items.map((v) => ({ ...v, code: v.code?.trim().toUpperCase() || valueCode(v.value) })))
  .superRefine((items, ctx) => {
    const lower = items.map((v) => v.value.toLowerCase());
    if (new Set(lower).size !== lower.length) ctx.addIssue({ code: 'custom', message: 'Có giá trị bị trùng' });
    const ids = items.flatMap((v) => (v.id === undefined ? [] : [v.id]));
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Một giá trị được gửi hai lần' });
    const seen = new Set<string>();
    items.forEach((v, i) => {
      if (!CODE.test(v.code)) {
        ctx.addIssue({ code: 'custom', path: [i, 'code'], message: v.code ? 'Mã chỉ gồm A-Z, 0-9, tối đa 6 ký tự' : 'Nhập mã' });
      } else if (seen.has(v.code)) {
        ctx.addIssue({ code: 'custom', path: [i, 'code'], message: 'Mã bị trùng' });
      }
      seen.add(v.code);
    });
  });

export const AttributeBody = z.object({ name: name('thuộc tính', 40), values }).meta({ id: 'AttributeRequest' });
export const UpdateAttributeBody = AttributeBody.extend({ version }).meta({ id: 'UpdateAttributeRequest' });

// ---------- Sản phẩm, biến thể ----------

const description = z
  .string()
  .max(5000, 'Mô tả tối đa 5000 ký tự')
  .nullish()
  .transform((v) => v ?? '');

// Ảnh theo thứ tự hiển thị, ảnh đầu là ảnh đại diện (#303). `PUT` không gửi thì giữ nguyên, `[]` thì gỡ hết.
const imageFileIds = z
  .array(z.string())
  .optional()
  .meta({ description: `Tối đa ${MAX_PRODUCT_IMAGES} ảnh (P8), theo thứ tự hiển thị; ảnh đầu là ảnh đại diện` });

/**
 * Số ảnh (P8) và ảnh lặp kiểm ngay ở đây, trước khi hỏi kho tệp: body nhiều id không kéo theo nhiều lời gọi kho (#303).
 * Lỗi ở `errors.images` như FE hiện; câu khớp mock FE.
 */
function imageLimits(body: { imageFileIds?: string[] | undefined }, ctx: z.RefinementCtx) {
  const ids = body.imageFileIds ?? [];
  if (ids.length > MAX_PRODUCT_IMAGES) {
    ctx.addIssue({ code: 'custom', path: ['images'], message: `Tối đa ${MAX_PRODUCT_IMAGES} ảnh` });
  } else if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: 'custom', path: ['images'], message: 'Ảnh bị trùng' });
  }
}

const attributeValueIds = z.array(z.string(), 'Chọn giá trị thuộc tính');

// Ảnh bảng kích cỡ (#347): một tệp JPG/PNG ≤ 1 MB như ảnh sản phẩm; TikTok bắt buộc với quần áo, giày dép.
const sizeChartFileId = z
  .string()
  .nullish()
  .meta({ description: 'Tệp ảnh bảng kích cỡ (một ảnh). `PUT`: bỏ trống thì giữ nguyên, `null` thì gỡ; lỗi ở `errors.sizeChart`' });

export const CreateProductBody = z
  .object({
    name: name('sản phẩm', 200),
    categoryId: z.string('Chọn danh mục').min(1, 'Chọn danh mục'),
    description,
    imageFileIds,
    sizeChartFileId,
    variants: z
      .array(z.object({ attributeValueIds }), 'Cần ít nhất một biến thể')
      .min(1, 'Cần ít nhất một biến thể')
      .max(100, 'Tối đa 100 biến thể mỗi lần tạo'),
  })
  .superRefine(imageLimits)
  .meta({ id: 'CreateProductRequest' });

/** Không có danh mục và biến thể: gửi kèm thì bỏ qua (P6, AC-13). */
export const UpdateProductBody = z
  .object({ name: name('sản phẩm', 200), description, imageFileIds, sizeChartFileId, version })
  .superRefine(imageLimits)
  .meta({ id: 'UpdateProductRequest' });

export const AddVariantBody = z.object({ attributeValueIds }).meta({ id: 'AddVariantRequest' });

const POSITIVE_INT = 'Nhập số nguyên lớn hơn 0';
/** Giá (đồng) của SKU; bỏ trường là giữ, `null` là xoá. */
const price = z.int(POSITIVE_INT).positive(POSITIVE_INT).nullable().optional();
/** Cân nặng (g), kích thước (mm): cột `integer` của PostgreSQL, vượt trần thì 422 thay vì lỗi DB. */
const measure = z.int(POSITIVE_INT).positive(POSITIVE_INT).max(2_147_483_647, 'Số quá lớn').nullable().optional();

/**
 * Sửa một SKU (#204, Documents/21 §17.2). Chưa nhận `imageFileId` (spec 204 D1): trường lạ trả 422. Ngưỡng tồn đặt ở
 * inventory (mục 15), không ở đây.
 */
export const UpdateVariantBody = z
  .strictObject(
    {
      version,
      standardPrice: price.meta({ description: 'Giá chuẩn (đồng)' }),
      targetNetPrice: price.meta({ description: 'Giá muốn bán: số muốn thực nhận mỗi món (đồng); đổi thì phát `catalog.variant_price_changed`' }),
      weightG: measure.meta({ description: 'Cân nặng gói (gam)' }),
      lengthMm: measure.meta({ description: 'Chiều dài gói (mm)' }),
      widthMm: measure.meta({ description: 'Chiều rộng gói (mm)' }),
      heightMm: measure.meta({ description: 'Chiều cao gói (mm)' }),
    },
    { error: (iss) => (iss.code === 'unrecognized_keys' ? `Không sửa được trường ${iss.keys.join(', ')} ở đây` : undefined) },
  )
  .meta({ id: 'UpdateVariantRequest' });

/**
 * Đổi trạng thái kinh doanh (#204, Documents/21 §17.2). Bỏ `variantIds` là áp cho mọi SKU con; id sai dạng hoặc lặp thì
 * 422, id không thuộc sản phẩm thì service trả 422 `errors.variantIds`.
 */
export const BusinessStatusBody = z
  .object({
    action: z.enum(BUSINESS_ACTIONS, 'Thao tác không hợp lệ'),
    variantIds: z
      .array(z.uuid('SKU không hợp lệ'), 'Chọn SKU')
      .min(1, 'Chọn ít nhất một SKU')
      .optional()
      .superRefine((ids, ctx) => {
        if (ids && new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Một SKU được chọn hai lần' });
      }),
  })
  .meta({ id: 'BusinessStatusRequest' });

/** Ô rỗng (`categoryId=`) coi như không lọc: FE gửi vậy (AC-14). */
const blankAsMissing = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema);

export const ProductListQuery = z.object({
  search: blankAsMissing(z.string('Chỉ gửi một từ khoá').trim().optional()),
  categoryId: blankAsMissing(z.uuid('Danh mục không hợp lệ').optional()),
  /** `active`: còn SKU chưa lưu trữ; `archived`: mọi SKU đã lưu trữ (#204). */
  status: blankAsMissing(z.enum(['active', 'archived'], 'Trạng thái là active hoặc archived').default('active')),
  /** Có ít nhất một SKU ở trạng thái này; lọc lưu trữ dùng `status=archived` (#204). */
  businessStatus: blankAsMissing(
    z.enum(['selling', 'paused', 'discontinued'], 'Trạng thái kinh doanh là selling, paused hoặc discontinued').optional(),
  ),
  page: blankAsMissing(z.coerce.number().int().min(1, 'Trang từ 1').default(1)),
  pageSize: blankAsMissing(z.coerce.number().int().min(1, 'Từ 1 đến 100 dòng').max(100, 'Từ 1 đến 100 dòng').default(20)),
});

// ---------- Schema trả về, chỉ dùng cho Swagger ----------

export const Category = z
  .object({
    id: z.uuid(),
    name: z.string(),
    skuPattern: z.string(),
    skuNextSeq: z.number().int().meta({ description: 'Số thứ tự cấp cho biến thể kế tiếp ({SEQ})' }),
    suggest: SuggestConfig,
    productCount: z.number().int().meta({ description: 'Số sản phẩm, kể cả đã lưu trữ' }),
    version: z.number().int(),
    updatedAt: z.string(),
  })
  .meta({ id: 'Category' });

export const Attribute = z
  .object({
    id: z.uuid(),
    name: z.string(),
    values: z.array(
      z.object({
        id: z.uuid(),
        value: z.string(),
        code: z.string().meta({ description: 'Mã ghép vào {VAL} của SKU (V21)' }),
        inUse: z.boolean().meta({ description: 'Có biến thể dùng (kể cả đã ngừng bán): không xoá được' }),
      }),
    ),
    productCount: z.number().int(),
    version: z.number().int(),
  })
  .meta({ id: 'Attribute' });

export const Variant = z
  .object({
    id: z.uuid(),
    sku: z.string(),
    attributes: z.array(
      z.object({ attributeId: z.uuid(), attributeName: z.string(), valueId: z.uuid(), value: z.string() }),
    ),
    archivedAt: z.string().nullable().meta({ description: 'Lưu trữ lúc nào; null là chưa lưu trữ' }),
    businessStatus: z
      .enum(BUSINESS_STATUSES)
      .meta({ description: 'Trạng thái kinh doanh của SKU (Documents/21 §17.1)' }),
    standardPrice: z
      .number()
      .int()
      .nullable()
      .meta({ description: 'Giá chuẩn (đồng); null khi chưa có giá' }),
    targetNetPrice: z
      .number()
      .int()
      .nullable()
      .meta({ description: 'Giá muốn bán: số muốn thực nhận mỗi món (đồng, Documents/25 §6.2); null khi chưa đặt' }),
    weightG: z.number().int().nullable().meta({ description: 'Cân nặng gói (gam); null khi chưa nhập' }),
    lengthMm: z.number().int().nullable().meta({ description: 'Chiều dài gói (mm); null khi chưa nhập' }),
    widthMm: z.number().int().nullable().meta({ description: 'Chiều rộng gói (mm); null khi chưa nhập' }),
    heightMm: z.number().int().nullable().meta({ description: 'Chiều cao gói (mm); null khi chưa nhập' }),
    version: z.number().int().meta({ description: 'Version của SKU, gửi kèm PATCH /products/:id/variants/:variantId' }),
    archiveBlockers: z
      .array(z.string())
      .meta({ description: 'Lý do chưa lưu trữ được (tồn, chứng từ mở); chỉ tính cho SKU Ngừng nhập, rỗng là lưu trữ được' }),
    readiness: z.enum(['ready', 'incomplete']).meta({ description: 'Độ hoàn thiện (Documents/25 §5.4): đủ mọi phần ở `missing` thì ready' }),
    missing: z.array(z.enum(MISSING_FIELDS)).meta({
      description:
        'Phần còn thiếu theo thứ tự cố định; `name`, `category`, `image` ở sản phẩm cha, `price` là giá muốn bán (`targetNetPrice`)',
    }),
    minQty: z.number().int().nullable().meta({ description: 'Ngưỡng tồn (inventory); null là chưa đặt' }),
    presence: z.enum(PRESENCES).meta({
      description: 'Hiện diện trên sàn (Documents/25 §5.1): live > error > pending > not_listed; listing `hidden` không tính là live',
    }),
    hasListingError: z.boolean().meta({ description: 'Có listing lỗi (push_failed, rejected, platform_hold), kể cả khi đã live' }),
    listingCount: z.number().int().meta({ description: 'Số listing chưa gỡ, mọi gian hàng' }),
  })
  .meta({ id: 'ProductVariant' });

const LabelCounts = z
  .object(Object.fromEntries(MAIN_LABELS.map((l) => [l, z.number().int()])) as Record<MainLabel, z.ZodNumber>)
  .meta({
    id: 'LabelCounts',
    description: 'Số SKU theo nhãn chính, đủ 7 khoá, tính mọi SKU: trạng thái kinh doanh khác selling, không thì hiện diện trên sàn',
  });

export const ProductListItem = z
  .object({
    id: z.uuid(),
    name: z.string(),
    code: z.string().meta({ description: 'Mã cha, cấp lúc tạo theo quy tắc SKU của danh mục, không sửa (#204 D5)' }),
    category: z.object({ id: z.uuid(), name: z.string() }),
    variantCount: z.number().int().meta({ description: 'Số SKU chưa lưu trữ' }),
    variantTotal: z.number().int().meta({ description: 'Số SKU, kể cả đã lưu trữ' }),
    labelCounts: LabelCounts,
    incompleteCount: z.number().int().meta({ description: 'Số SKU chưa lưu trữ còn thiếu phần (readiness incomplete)' }),
    errorCount: z.number().int().meta({ description: 'Số SKU chưa lưu trữ có listing lỗi, kể cả SKU đang live' }),
    thumbnailUrl: z.string().nullable(),
    status: z.enum(['active', 'archived']).meta({ description: '`archived` khi mọi SKU đã lưu trữ (suy từ SKU, không lưu)' }),
    updatedAt: z.string(),
    version: z.number().int(),
  })
  .meta({ id: 'ProductListItem' });

export const ProductDetail = ProductListItem.extend({
  description: z.string(),
  images: z.array(
    z
      .object({
        id: z.string(),
        fileId: z.uuid(),
        url: z.string().meta({ description: 'Link cố định của ảnh; chuỗi rỗng khi máy chủ chưa cấu hình link ảnh' }),
        position: z.number().int().meta({ description: '0 là ảnh đại diện' }),
      })
      .meta({ id: 'ProductImage' }),
  ),
  sizeChart: z
    .object({ fileId: z.uuid(), url: z.string().meta({ description: 'Link cố định của ảnh; chuỗi rỗng khi máy chủ chưa cấu hình link ảnh' }) })
    .nullable()
    .meta({ description: 'Ảnh bảng kích cỡ (#347); null khi chưa có' }),
  variants: z.array(Variant),
}).meta({ id: 'ProductDetail' });

export const ProductPage = z
  .object({ items: z.array(ProductListItem), total: z.number().int(), page: z.number().int(), pageSize: z.number().int() })
  .meta({ id: 'ProductPage' });

export const BusinessStatusResult = z
  .object({
    product: ProductDetail,
    applied: z.array(z.uuid()).meta({ description: 'SKU đã đổi trạng thái' }),
    skipped: z
      .array(
        z.object({
          variantId: z.uuid(),
          sku: z.string(),
          code: z.enum(['invalid_transition', 'archive_blocked']),
          reasons: z.array(z.string()).meta({ description: 'Lý do chặn lưu trữ; rỗng với invalid_transition' }),
        }),
      )
      .meta({ description: 'SKU bỏ qua: không có thao tác này từ trạng thái hiện tại, hoặc bị chặn lưu trữ' }),
  })
  .meta({ id: 'BusinessStatusResult' });

// ---------- Sửa hàng loạt có gợi ý (#242, Documents/21 §17.5) ----------

const BULK_MAX_ROWS = 200;

export { BulkRowInput };

export const BulkEditQuery = z.object({
  search: blankAsMissing(z.string('Chỉ gửi một từ khoá').trim().max(100, 'Từ khoá tối đa 100 ký tự').optional()),
  categoryId: blankAsMissing(z.uuid('Danh mục không hợp lệ').optional()),
  incomplete: blankAsMissing(
    z
      .enum(['true', 'false'], 'incomplete là true hoặc false')
      .default('false')
      .transform((v) => v === 'true'),
  ),
  page: blankAsMissing(z.coerce.number().int().min(1, 'Trang từ 1').default(1)),
  pageSize: blankAsMissing(z.coerce.number().int().min(1, 'Từ 1 dòng').max(BULK_MAX_ROWS, `Tối đa ${BULK_MAX_ROWS} dòng`).default(50)),
});

/** Thân PATCH hàng loạt cho Zod kiểm: `rows` để thô, từng dòng kiểm bằng `BulkRowInput` ở service. */
export const BulkSaveBody = z
  .object({ rows: z.array(z.unknown(), 'Thiếu rows').min(1, 'Gửi ít nhất một dòng') })
  .meta({ id: 'BulkEditSaveRequest', description: `Tối đa ${BULK_MAX_ROWS} dòng, vượt thì 400 \`too_many_rows\`` });
/** Cùng thân, dùng cho tài liệu OpenAPI (kiểu từng dòng rõ ràng). */
export const BulkSaveDocBody = z.object({ rows: z.array(BulkRowInput).min(1).max(BULK_MAX_ROWS) }).meta({ id: 'BulkEditSaveDocRequest' });

const Suggestion = z
  .object({ value: z.number(), basis: z.string().meta({ description: 'Câu giải thích cách ra số' }) })
  .meta({ id: 'BulkEditSuggestion' });
const nullableInt = z.number().int().nullable();

export const BulkEditRow = z
  .object({
    variantId: z.uuid(),
    productId: z.uuid(),
    productName: z.string(),
    sku: z.string(),
    attributesLabel: z.string().meta({ description: 'Vd "Trắng / L"; rỗng khi SKU không có thuộc tính' }),
    categoryName: z.string(),
    version: z.number().int().meta({ description: '`version` của SKU' }),
    reorderVersion: nullableInt.meta({ description: '`version` của dòng tồn; null khi chưa có dòng (gửi null hoặc 0)' }),
    current: z.object({
      standardPrice: nullableInt,
      targetNetPrice: nullableInt,
      minQty: nullableInt,
      weightG: nullableInt,
      lengthMm: nullableInt,
      widthMm: nullableInt,
      heightMm: nullableInt,
    }),
    source: z
      .object({
        purchaseRequestNumber: z.string(),
        supplierName: z.string().nullable(),
        lastCost: z.number().nullable().meta({ description: 'Giá nhập; null khi thiếu `inventory.cost.view`' }),
      })
      .nullable()
      .meta({ description: 'Đề nghị nhập đã duyệt gần nhất có SKU; null khi chưa từng nhập' }),
    suggestions: z
      .partialRecord(z.enum(['standardPrice', 'targetNetPrice', 'minQty', 'weightG', 'lengthMm', 'widthMm', 'heightMm']), Suggestion)
      .meta({ description: 'Chỉ có cho ô đang trống. Không tự lưu' }),
  })
  .meta({ id: 'BulkEditRow' });

export const BulkEditPage = z
  .object({ items: z.array(BulkEditRow), total: z.number().int(), page: z.number().int(), pageSize: z.number().int() })
  .meta({ id: 'BulkEditPage' });

export const BulkSaveResult = z
  .object({
    saved: z.array(z.object({ variantId: z.string(), version: z.number().int().meta({ description: '`version` mới của SKU' }) })),
    failed: z.array(
      z.object({
        variantId: z.string(),
        code: z.enum(['validation_failed', 'version_conflict', 'not_found', 'product_archived', 'listing_field_required']),
        message: z.string(),
        errors: z
          .record(z.string(), z.string())
          .optional()
          .meta({ description: 'Lỗi theo ô, chỉ với `validation_failed`, `listing_field_required` và `version_conflict` của ngưỡng' }),
      }),
    ),
  })
  .meta({ id: 'BulkEditSaveResult' });
