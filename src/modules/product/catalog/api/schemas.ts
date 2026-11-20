import { z } from 'zod';
import { BUSINESS_ACTIONS, BUSINESS_STATUSES } from '../domain/business-status.ts';
import { MAIN_LABELS, type MainLabel, MISSING_FIELDS, PRESENCES } from '../domain/labels.ts';
import { BulkRowInput } from '../domain/bulk-row.ts';
import { skuPatternError, valueCode } from '../domain/sku.ts';
import { PLATFORM_KINDS, SPEC_INPUTS } from '../domain/specs.ts';
import { MAX_PRODUCT_IMAGES } from '../service/product-images.ts';

// Giới hạn (Documents/21 V24, mục 5.2): tên nhóm hàng 60, sản phẩm 200, mô tả 5000; tên thuộc tính 15, giá trị 20
// (luật Lazada `VARIATION_*`, 19/11/2026).

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
/** Ảnh phân loại (#340): `attributeValueId` sai dạng ra 422 câu hợp đồng (PUT) hoặc 200 (DELETE) ở service. */
export const VariantImageParams = z.object({ id: z.string(), attributeValueId: z.string() });
export const VersionQuery = z.object({ version: z.coerce.number('Thiếu version').int().positive('Thiếu version') });

// ---------- Nhóm hàng, cài đặt sản phẩm ----------

const skuPattern = z
  .string('Nhập quy tắc SKU')
  .trim()
  .superRefine((value, ctx) => {
    const message = skuPatternError(value);
    if (message) ctx.addIssue({ code: 'custom', message });
  })
  .meta({ example: 'SP{SEQ:5}-{VAL}', description: 'Mẫu SKU của công ty (Documents/21 5.1, mục 9)' });

const optionalInt = (max: number, min = 0) =>
  z
    .number('Nhập số nguyên')
    .int('Nhập số nguyên')
    .min(min, `Từ ${min} trở lên`)
    .max(max, `Tối đa ${max}`)
    .nullable();

/** Cấu hình gợi ý khi sửa hàng loạt (#242). Gửi thì thay cả năm giá trị; `null` là chưa đặt (nhóm: theo công ty). */
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
  .meta({ id: 'SuggestConfig' });

const keepSuggest = SuggestConfig.optional().meta({ description: 'Bỏ trống thì giữ cấu hình đang lưu (tạo mới: chưa đặt)' });

export const GroupBody = z
  .object({
    name: name('nhóm hàng', 60),
    suggest: keepSuggest,
    copyTemplateFromGroupId: z
      .string()
      .optional()
      .meta({ description: 'Chép trục chuẩn và mẫu thông số của nhóm này (#510); PUT thay mẫu cũ. Cần catalog.group.manage' }),
  })
  .meta({ id: 'ProductGroupRequest' });
export const UpdateGroupBody = GroupBody.extend({ version }).meta({ id: 'UpdateProductGroupRequest' });

/** Không gửi `productIds` là chuyển cả nhóm (21 mục 5.2). */
export const MoveProductsBody = z
  .object({
    targetGroupId: z.string('Chọn nhóm hàng đích').min(1, 'Chọn nhóm hàng đích'),
    productIds: z.array(z.string()).min(1, 'Chọn sản phẩm').max(1000, 'Tối đa 1000 sản phẩm mỗi lần').optional(),
  })
  .meta({ id: 'MoveProductsRequest' });

export const SettingsBody = z.object({ skuPattern, suggest: keepSuggest, version }).meta({ id: 'ProductSettingsRequest' });

// ---------- Thuộc tính ----------

const CODE = /^[A-Z0-9]{1,6}$/;
const MAX_ATTRIBUTE_NAME = 15;
const MAX_VALUE = 20;
/** Lazada: tối đa 50 giá trị mỗi trục của một sản phẩm. */
const MAX_AXIS_VALUES = 50;

/**
 * Mã bỏ trống thì sinh từ giá trị (bảng 9.2, V21). Lỗi ở `values.<i>.code`, giá trị trùng ở `values`
 * (khớp mock FE `validateAttribute`).
 */
const values = z
  .array(
    z.object({
      id: z.string().optional(),
      value: z.string('Nhập giá trị').trim().min(1, 'Nhập giá trị').max(MAX_VALUE, `Mỗi giá trị tối đa ${MAX_VALUE} ký tự`),
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

export const AttributeBody = z.object({ name: name('thuộc tính', MAX_ATTRIBUTE_NAME), values }).meta({ id: 'AttributeRequest' });
export const UpdateAttributeBody = AttributeBody.extend({ version }).meta({ id: 'UpdateAttributeRequest' });

// ---------- Thông số sản phẩm (#510, Documents/21 mục 5.5) ----------

const SPEC_CODE = /^[a-z0-9_]{1,40}$/;
const specOption = z.string('Nhập lựa chọn').trim().min(1, 'Nhập lựa chọn').max(60, 'Mỗi lựa chọn tối đa 60 ký tự');
const specUnit = z.string().trim().min(1, 'Nhập đơn vị').max(10, 'Đơn vị tối đa 10 ký tự').nullish();

export const SpecFieldBody = z
  .object({
    code: z
      .string()
      .trim()
      .regex(SPEC_CODE, 'Mã chỉ gồm a-z, 0-9, _, tối đa 40 ký tự')
      .optional()
      .meta({ description: 'Bỏ trống thì sinh từ tên (bỏ dấu, chữ thường, `_`; trùng thì thêm số). Không sửa sau khi tạo' }),
    name: name('thông số', 40),
    input: z.enum(SPEC_INPUTS, 'Chọn kiểu nhập'),
    unit: specUnit.meta({ description: 'Chỉ khi `input = number`' }),
    allowCustom: z.boolean('Chọn có nhận giá trị ngoài danh sách không'),
    options: z.array(z.object({ value: specOption })).max(500, 'Tối đa 500 lựa chọn').optional(),
  })
  .meta({ id: 'SpecFieldRequest' });

export const UpdateSpecFieldBody = z
  .object({
    name: name('thông số', 40),
    unit: specUnit,
    allowCustom: z.boolean('Chọn có nhận giá trị ngoài danh sách không'),
    options: z
      .array(z.object({ id: z.string().optional(), value: specOption }))
      .max(500, 'Tối đa 500 lựa chọn')
      .optional()
      .meta({ description: 'Thứ tự mảng là `position`; lựa chọn cũ vắng mặt là xoá' }),
    version,
  })
  .meta({ id: 'UpdateSpecFieldRequest' });

export const GroupTemplateBody = z
  .object({
    axisAttributeIds: z
      .array(z.string())
      .max(2, 'Tối đa 2 trục phân loại')
      .refine((ids) => new Set(ids).size === ids.length, 'Hai trục phải khác nhau'),
    fields: z
      .array(z.object({ fieldId: z.string(), required: z.boolean() }))
      .max(100, 'Tối đa 100 thông số')
      .superRefine((fields, ctx) => {
        const seen = new Set<string>();
        fields.forEach((f, i) => {
          if (seen.has(f.fieldId)) ctx.addIssue({ code: 'custom', path: [i, 'fieldId'], message: 'Thông số bị trùng' });
          seen.add(f.fieldId);
        });
      }),
    version,
  })
  .meta({ id: 'GroupTemplateRequest' });

/** Giá trị một thông số (Documents/21 mục 5.5 `SpecInput`); luật theo kiểu nhập kiểm ở service (cần định nghĩa thông số). */
const SpecInputBody = z
  .object({
    fieldId: z.string('Chọn thông số'),
    optionIds: z.array(z.string()).max(20, 'Chọn tối đa 20 giá trị').optional(),
    newValues: z.array(z.string()).max(20, 'Chọn tối đa 20 giá trị').optional(),
    value: z.string().max(4000, 'Giá trị quá dài').optional(),
  })
  .meta({ id: 'SpecInput' });
const specs = z.array(SpecInputBody).max(200, 'Tối đa 200 thông số').optional();

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

const lowerTrim = (s: string) => s.trim().toLowerCase();

/** Trục phân loại (21 mục 5.2): `attributeId` thì dùng thuộc tính đó, chỉ `name` thì dùng hoặc tạo thuộc tính cùng tên. */
const Axis = z
  .object({
    attributeId: z.string().optional(),
    name: name('thuộc tính', MAX_ATTRIBUTE_NAME).optional(),
    values: z
      .array(
        z.object({
          id: z.string().optional(),
          value: z.string('Nhập giá trị').trim().min(1, 'Nhập giá trị').max(MAX_VALUE, `Mỗi giá trị tối đa ${MAX_VALUE} ký tự`),
        }),
        'Thêm ít nhất một giá trị',
      )
      .min(1, 'Thêm ít nhất một giá trị')
      .max(MAX_AXIS_VALUES, `Mỗi trục tối đa ${MAX_AXIS_VALUES} giá trị`),
  })
  .superRefine((axis, ctx) => {
    if (axis.attributeId === undefined && axis.name === undefined) {
      ctx.addIssue({ code: 'custom', path: ['name'], message: 'Nhập tên thuộc tính' });
    }
  })
  .meta({ id: 'ProductAxis' });

/**
 * Luật giữa các trục và biến thể (K16): tối đa 2 trục, hai trục khác thuộc tính, không trùng giá trị trong trục, mỗi
 * biến thể chọn đúng một giá trị của từng trục, không trùng tổ hợp; không trục thì đúng một biến thể `options: []`.
 */
function axesRules(body: { axes: z.infer<typeof Axis>[]; variants: { options: string[] }[] }, ctx: z.RefinementCtx) {
  const { axes, variants } = body;
  const fail = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  if (axes.length > 2) return fail(['axes'], 'Sản phẩm tối đa 2 thuộc tính phân loại');
  const ids = axes.flatMap((a) => (a.attributeId === undefined ? [] : [a.attributeId]));
  const names = axes.flatMap((a) => (a.attributeId === undefined && a.name ? [lowerTrim(a.name)] : []));
  if (new Set(ids).size !== ids.length || new Set(names).size !== names.length) {
    return fail(['axes'], 'Hai trục phải là hai thuộc tính khác nhau');
  }
  for (const [i, axis] of axes.entries()) {
    const values = axis.values.map((v) => lowerTrim(v.value));
    if (new Set(values).size !== values.length) return fail(['axes', i, 'values'], 'Có giá trị bị trùng trong trục');
  }
  if (!axes.length && variants.length !== 1) return fail(['variants'], 'Sản phẩm không có thuộc tính phân loại chỉ có một biến thể');
  const combos = new Set<string>();
  for (const [i, v] of variants.entries()) {
    const ok =
      v.options.length === axes.length &&
      v.options.every((o, k) => axes[k]!.values.some((x) => lowerTrim(x.value) === lowerTrim(o)));
    if (!ok) return fail(['variants', i], 'Chọn mỗi thuộc tính một giá trị có trong trục');
    const combo = JSON.stringify(v.options.map(lowerTrim));
    if (combos.has(combo)) return fail(['variants'], 'Có tổ hợp thuộc tính bị trùng');
    combos.add(combo);
  }
}

// Ảnh bảng kích cỡ (#347): một tệp JPG/PNG ≤ 1 MB như ảnh sản phẩm; TikTok bắt buộc với quần áo, giày dép.
const sizeChartFileId = z
  .string()
  .nullish()
  .meta({ description: 'Tệp ảnh bảng kích cỡ (một ảnh). `PUT`: bỏ trống thì giữ nguyên, `null` thì gỡ; lỗi ở `errors.sizeChart`' });

export const CreateProductBody = z
  .object({
    name: name('sản phẩm', 200),
    groupId: z.string('Chọn nhóm hàng').min(1, 'Chọn nhóm hàng'),
    description,
    imageFileIds,
    sizeChartFileId,
    axes: z.array(Axis, 'Gửi danh sách trục phân loại (rỗng nếu không có)'),
    variants: z
      .array(z.object({ options: z.array(z.string(), 'Chọn giá trị thuộc tính') }), 'Cần ít nhất một biến thể')
      .min(1, 'Cần ít nhất một biến thể')
      .max(100, 'Tối đa 100 biến thể mỗi lần tạo'),
    specs,
    originCountry: z.lazy(() => originCountry),
    brand: z.lazy(() => brand),
  })
  .superRefine(imageLimits)
  .superRefine(axesRules)
  .meta({ id: 'CreateProductRequest' });

// Thuộc tính gắn ảnh, xuất xứ, thương hiệu (#340, Documents/21 §17.2): bỏ trường là giữ, `null` là bỏ chọn / xoá.
const imageAttributeId = z
  .string()
  .nullish()
  .meta({ description: 'Thuộc tính gắn ảnh (một trục phân loại của sản phẩm); đổi hoặc `null` thì gỡ mọi ảnh phân loại cũ' });

const COUNTRY = /^[A-Z]{2}$/;
/** Cắt khoảng trắng, viết hoa; chuỗi rỗng sau khi cắt lưu `null` như `brand` (Đ1). */
const originCountry = z
  .string()
  .trim()
  .toUpperCase()
  .refine((v) => v === '' || COUNTRY.test(v), 'Mã nước không hợp lệ (2 chữ cái, vd VN)')
  .transform((v) => v || null)
  .nullish()
  .meta({ description: 'Xuất xứ, mã ISO 3166-1 alpha-2 (vd VN)' });

const brand = z
  .string()
  .trim()
  .max(100, 'Thương hiệu tối đa 100 ký tự')
  .transform((v) => v || null)
  .nullish()
  .meta({ description: 'Thương hiệu, tối đa 100 ký tự; rỗng hoặc `null` là không thương hiệu' });

const groupId = z.string('Chọn nhóm hàng').min(1, 'Chọn nhóm hàng').optional().meta({ description: 'Đổi nhóm hàng (P6); SKU không đổi' });

/** Không có biến thể: gửi kèm thì bỏ qua (AC-13). */
export const UpdateProductBody = z
  .object({
    name: name('sản phẩm', 200),
    description,
    imageFileIds,
    sizeChartFileId,
    imageAttributeId,
    originCountry,
    brand,
    groupId,
    specs: specs.meta({ description: "Thay giá trị của từng `fieldId` có trong mảng; `optionIds: []` hoặc `value: ''` là xoá" }),
    version,
  })
  .superRefine(imageLimits)
  .meta({ id: 'UpdateProductRequest' });

export const AddVariantBody = z.object({ attributeValueIds }).meta({ id: 'AddVariantRequest' });

/** Đặt ảnh phân loại (#340). `fileId` là chuỗi: id sai dạng báo ở `errors.image` như tệp không dùng được (A11). */
export const SetVariantImageBody = z
  .strictObject({ fileId: z.string('Chọn ảnh').meta({ description: 'Tệp lấy bằng POST /files/uploads, purpose product_image' }) })
  .meta({ id: 'SetVariantImageRequest' });

const POSITIVE_INT = 'Nhập số nguyên lớn hơn 0';
/** Giá (đồng) của SKU; bỏ trường là giữ, `null` là xoá. */
const price = z.int(POSITIVE_INT).positive(POSITIVE_INT).nullable().optional();
/** Cân nặng (g), kích thước (mm): cột `integer` của PostgreSQL, vượt trần thì 422 thay vì lỗi DB. */
const measure = z.int(POSITIVE_INT).positive(POSITIVE_INT).max(2_147_483_647, 'Số quá lớn').nullable().optional();

/**
 * Sửa một SKU (#204, Documents/21 §17.2). Không nhận `imageFileId`: ảnh phân loại đặt theo giá trị thuộc tính, không theo
 * SKU (#340); trường lạ trả 422. Ngưỡng tồn đặt ở inventory (mục 15), không ở đây.
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

/** Ô rỗng (`groupId=`) coi như không lọc: FE gửi vậy (AC-14). */
const blankAsMissing = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema);

export const ProductListQuery = z.object({
  search: blankAsMissing(z.string('Chỉ gửi một từ khoá').trim().optional()),
  groupId: blankAsMissing(z.uuid('Nhóm hàng không hợp lệ').optional()),
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

export const ProductGroup = z
  .object({
    id: z.uuid(),
    name: z.string(),
    productCount: z.number().int().meta({ description: 'Số sản phẩm, kể cả đã lưu trữ' }),
    axes: z
      .array(z.object({ attributeId: z.uuid(), name: z.string(), platformKind: z.enum(PLATFORM_KINDS).nullable() }))
      .meta({ description: 'Trục phân loại chuẩn của nhóm (0–2, theo thứ tự; #510)' }),
    specFieldCount: z.number().int().meta({ description: 'Số thông số trong mẫu nhóm' }),
    requiredCount: z.number().int().meta({ description: 'Số thông số bắt buộc trong mẫu nhóm' }),
    suggest: SuggestConfig,
    updatedAt: z.string(),
    version: z.number().int(),
  })
  .meta({ id: 'ProductGroup' });

const SpecOptionRef = z.object({ id: z.uuid(), value: z.string() });

export const SpecField = z
  .object({
    id: z.uuid(),
    code: z.string().meta({ description: 'Khoá ánh xạ sang sàn, không sửa' }),
    name: z.string(),
    input: z.enum(SPEC_INPUTS),
    unit: z.string().nullable(),
    allowCustom: z.boolean(),
    options: z.array(SpecOptionRef.extend({ position: z.number().int(), inUse: z.boolean() })),
    groupCount: z.number().int(),
    productCount: z.number().int(),
    updatedAt: z.string(),
    version: z.number().int(),
  })
  .meta({ id: 'SpecField' });

export const GroupTemplate = z
  .object({
    groupId: z.uuid(),
    axes: z.array(
      z.object({
        attributeId: z.uuid(),
        name: z.string(),
        platformKind: z.enum(PLATFORM_KINDS).nullable(),
        values: z.array(SpecOptionRef),
      }),
    ),
    fields: z.array(
      z.object({
        fieldId: z.uuid(),
        code: z.string(),
        name: z.string(),
        input: z.enum(SPEC_INPUTS),
        unit: z.string().nullable(),
        allowCustom: z.boolean(),
        required: z.boolean(),
        options: z.array(SpecOptionRef),
      }),
    ),
    version: z.number().int().meta({ description: '`version` của nhóm' }),
  })
  .meta({ id: 'GroupTemplate' });

export const ProductSpecValue = z
  .object({
    fieldId: z.uuid(),
    code: z.string(),
    name: z.string(),
    input: z.enum(SPEC_INPUTS),
    unit: z.string().nullable(),
    allowCustom: z.boolean(),
    required: z.boolean(),
    inTemplate: z.boolean().meta({ description: 'false: thông số ngoài mẫu nhóm hiện tại đang có giá trị ("Thông số khác")' }),
    selected: z.array(SpecOptionRef),
    choices: z.array(SpecOptionRef).meta({ description: 'Mọi lựa chọn của thông số' }),
    value: z.string().nullable().meta({ description: 'text, number (chuẩn hoá), date (YYYY-MM-DD)' }),
  })
  .meta({ id: 'ProductSpecValue' });

export const ProductSettings = z
  .object({
    skuPattern: z.string(),
    skuNextSeq: z.number().int().meta({ description: 'Số {SEQ} cấp cho SKU kế tiếp, chỉ đọc' }),
    suggest: SuggestConfig,
    version: z.number().int(),
  })
  .meta({ id: 'ProductSettings' });

export const Attribute = z
  .object({
    id: z.uuid(),
    name: z.string(),
    platformKind: z
      .enum(['color', 'size'])
      .nullable()
      .meta({ description: 'Thuộc tính chuẩn sàn (chỉ đọc, hệ thống tạo khi lập công ty); bước Variants của trang đẩy ghép sang Màu sắc, Kích cỡ của sàn' }),
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

/** Ảnh phân loại của một giá trị (#340). */
const VariantImage = z
  .object({
    attributeValueId: z.uuid(),
    fileId: z.uuid(),
    url: z.string().meta({ description: 'Link cố định của ảnh; chuỗi rỗng khi máy chủ chưa cấu hình link ảnh' }),
  })
  .meta({ id: 'VariantImage' });

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
    image: VariantImage.nullable().meta({
      description: 'Ảnh phân loại theo giá trị của SKU ở thuộc tính gắn ảnh (#340); null khi chưa chọn thuộc tính hoặc giá trị chưa có ảnh',
    }),
    archiveBlockers: z
      .array(z.string())
      .meta({ description: 'Lý do chưa lưu trữ được (tồn, chứng từ mở); chỉ tính cho SKU Ngừng nhập, rỗng là lưu trữ được' }),
    readiness: z.enum(['ready', 'incomplete']).meta({ description: 'Độ hoàn thiện (Documents/25 §5.4): đủ mọi phần ở `missing` thì ready' }),
    missing: z.array(z.enum(MISSING_FIELDS)).meta({
      description:
        'Phần còn thiếu theo thứ tự cố định; `name`, `image` ở sản phẩm cha, `price` là giá muốn bán (`targetNetPrice`)',
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
    code: z.string().meta({ description: 'Mã cha, cấp lúc tạo theo mẫu SKU của công ty, không sửa (#204 D5)' }),
    group: z.object({ id: z.uuid(), name: z.string() }),
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
  imageAttributeId: z.uuid().nullable().meta({ description: 'Thuộc tính gắn ảnh (#340); null khi chưa chọn' }),
  attributeValueImages: z
    .array(VariantImage)
    .meta({ description: 'Ảnh phân loại theo giá trị của thuộc tính gắn ảnh, theo thứ tự giá trị trong thuộc tính' }),
  originCountry: z.string().nullable().meta({ description: 'Xuất xứ, mã ISO 3166-1 alpha-2; null khi chưa đặt' }),
  brand: z.string().nullable().meta({ description: 'Thương hiệu; null là không thương hiệu' }),
  specs: z.array(ProductSpecValue).meta({ description: 'Thông số của mẫu nhóm (theo thứ tự, kể cả trống), rồi thông số ngoài mẫu có giá trị' }),
  missingSpecFieldIds: z.array(z.uuid()).meta({ description: 'Thông số bắt buộc của mẫu đang trống' }),
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
  groupId: blankAsMissing(z.uuid('Nhóm hàng không hợp lệ').optional()),
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
    groupName: z.string(),
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
