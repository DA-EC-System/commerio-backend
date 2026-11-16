import { z } from 'zod';
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

export const CategoryBody = z.object({ name: name('danh mục', 60), skuPattern }).meta({ id: 'CategoryRequest' });
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

export const CreateProductBody = z
  .object({
    name: name('sản phẩm', 200),
    categoryId: z.string('Chọn danh mục').min(1, 'Chọn danh mục'),
    description,
    imageFileIds,
    variants: z
      .array(z.object({ attributeValueIds }), 'Cần ít nhất một biến thể')
      .min(1, 'Cần ít nhất một biến thể')
      .max(100, 'Tối đa 100 biến thể mỗi lần tạo'),
  })
  .superRefine(imageLimits)
  .meta({ id: 'CreateProductRequest' });

/** Không có danh mục và biến thể: gửi kèm thì bỏ qua (P6, AC-13). */
export const UpdateProductBody = z
  .object({ name: name('sản phẩm', 200), description, imageFileIds, version })
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

/** Ô rỗng (`categoryId=`) coi như không lọc: FE gửi vậy (AC-14). */
const blankAsMissing = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema);

export const ProductListQuery = z.object({
  search: blankAsMissing(z.string('Chỉ gửi một từ khoá').trim().optional()),
  categoryId: blankAsMissing(z.uuid('Danh mục không hợp lệ').optional()),
  status: blankAsMissing(z.enum(['active', 'archived'], 'Trạng thái là active hoặc archived').default('active')),
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
    archivedAt: z.string().nullable().meta({ description: 'Ngừng bán lúc nào; null là đang bán' }),
    businessStatus: z
      .enum(['selling', 'paused', 'discontinued', 'archived'])
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
  })
  .meta({ id: 'ProductVariant' });

export const ProductListItem = z
  .object({
    id: z.uuid(),
    name: z.string(),
    category: z.object({ id: z.uuid(), name: z.string() }),
    variantCount: z.number().int().meta({ description: 'Số biến thể đang bán' }),
    thumbnailUrl: z.string().nullable(),
    status: z.enum(['active', 'archived']),
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
  variants: z.array(Variant),
}).meta({ id: 'ProductDetail' });

export const ProductPage = z
  .object({ items: z.array(ProductListItem), total: z.number().int(), page: z.number().int(), pageSize: z.number().int() })
  .meta({ id: 'ProductPage' });
