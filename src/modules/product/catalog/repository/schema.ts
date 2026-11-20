import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { money, timestamps, version } from '../../../../shared/db/columns.ts';

// Mọi bảng của module `catalog` khai báo trong schema này.
export const catalogSchema = pgSchema('product');

/**
 * Gợi ý giá, ngưỡng tồn khi sửa hàng loạt (#242, Documents/25 §5.3), chung cho nhóm hàng và cài đặt công ty; `null` là chưa
 * đặt. Giá muốn bán gợi ý = giá nhập × hệ số, làm tròn lên theo bước `price_rounding` (đồng). Ngưỡng tồn = tốc độ bán/ngày ×
 * số ngày chờ hàng + tồn an toàn; SKU chưa có lịch sử bán thì lấy `reorder_default_qty`.
 */
const suggestColumns = {
  marginCoefficient: numeric('margin_coefficient', { precision: 18, scale: 2 }),
  priceRounding: integer('price_rounding'),
  reorderLeadDays: integer('reorder_lead_days'),
  reorderSafetyQty: integer('reorder_safety_qty'),
  reorderDefaultQty: integer('reorder_default_qty'),
};

type SuggestColumns = { [K in keyof typeof suggestColumns]: AnyPgColumn };

function suggestChecks(table: string, t: SuggestColumns) {
  return [
    check(`${table}_margin_coefficient`, sql`${t.marginCoefficient} >= 1`),
    check(`${table}_price_rounding`, sql`${t.priceRounding} > 0`),
    check(`${table}_reorder_config`, sql`${t.reorderLeadDays} >= 0 and ${t.reorderSafetyQty} >= 0 and ${t.reorderDefaultQty} >= 0`),
  ];
}

/**
 * Nhóm hàng (Documents/19 D11, 21 mục 5.2): một cấp, không gắn sàn, không gắn SKU. Tên không trùng theo chữ thường trong
 * công ty. Gợi ý `null` thì theo cài đặt công ty.
 */
export const productGroups = catalogSchema.table(
  'product_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    name: text('name').notNull(),
    ...suggestColumns,
    ...timestamps,
    ...version,
  },
  (t) => [uniqueIndex('product_groups_company_lower_name_uq').on(t.companyId, sql`lower(${t.name})`), ...suggestChecks('product_groups', t)],
);

/**
 * Cài đặt sản phẩm của công ty (D11): mẫu SKU, số {SEQ} kế tiếp, gợi ý mặc định. Một dòng mỗi công ty, tạo cùng công ty
 * (`seedCompanyDefaults`); RLS ở migration `*_nhom-hang-rls-quyen`. Cấp số SKU không tăng `version` (khoá advisory
 * `lockVariants` tuần tự hoá việc cấp số).
 */
export const companyProductSettings = catalogSchema.table(
  'company_product_settings',
  {
    companyId: uuid('company_id').primaryKey(),
    skuPattern: text('sku_pattern').notNull().default('SP{SEQ:5}-{VAL}'),
    skuNextSeq: integer('sku_next_seq').notNull().default(1),
    ...suggestColumns,
    ...timestamps,
    ...version,
  },
  (t) => [check('company_product_settings_sku_next_seq', sql`${t.skuNextSeq} >= 1`), ...suggestChecks('company_product_settings', t)],
);

/** Loại thuộc tính chuẩn sàn (21 mục 5.2): bước Variants của trang đẩy ghép `color`, `size` sang trục chuẩn của sàn. */
export const PLATFORM_KINDS = ['color', 'size'] as const;

export const attributes = catalogSchema.table(
  'attributes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    name: text('name').notNull(),
    // Thuộc tính chuẩn sàn, do hệ thống gắn khi lập công ty; API chỉ đọc.
    platformKind: text('platform_kind', { enum: PLATFORM_KINDS }),
    ...timestamps,
    ...version,
  },
  (t) => [
    uniqueIndex('attributes_company_lower_name_uq').on(t.companyId, sql`lower(${t.name})`),
    uniqueIndex('attributes_company_platform_kind_uq').on(t.companyId, t.platformKind).where(sql`${t.platformKind} is not null`),
    check('attributes_platform_kind', sql`${t.platformKind} in ('color', 'size')`),
    // Tên trục tối đa 15 ký tự (Lazada `VARIATION_*`, Documents/21 mục 5.2).
    check('attributes_name_length', sql`char_length(${t.name}) <= 15`),
  ],
);

/** Giá trị thuộc tính; `code` là phần ghép vào {VAL} của SKU (19-D27, D36). */
export const attributeValues = catalogSchema.table(
  'attribute_values',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    attributeId: uuid('attribute_id')
      .notNull()
      .references(() => attributes.id),
    value: text('value').notNull(),
    code: text('code').notNull(),
    ...timestamps,
    ...version,
  },
  (t) => [
    uniqueIndex('attribute_values_attribute_lower_value_uq').on(t.attributeId, sql`lower(${t.value})`),
    unique().on(t.attributeId, t.code),
    // Đích của khoá ngoại ghép `pavi_value_fk` (#340, migration `*_anh-phan-loai-rls`).
    unique('attribute_values_id_attribute_uq').on(t.id, t.attributeId),
    check('attribute_values_code_format', sql`${t.code} ~ '^[A-Z0-9]{1,6}$'`),
    // Giá trị tối đa 20 ký tự (Lazada, Documents/21 mục 5.2).
    check('attribute_values_value_length', sql`char_length(${t.value}) <= 20`),
  ],
);

/**
 * Sản phẩm; đổi nhóm hàng được, SKU không đổi theo (Documents/21 P6, 19/11/2026). Không có trạng thái lưu riêng: trạng thái suy từ SKU con
 * (#204). `code` là mã cha cấp lúc tạo, không route nào sửa (spec 204 D5).
 */
export const products = catalogSchema.table(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => productGroups.id),
    name: text('name').notNull(),
    code: text('code').notNull(),
    description: text('description'),
    // Ảnh bảng kích cỡ (#347): một ảnh mỗi sản phẩm, tệp ở module `files` như ảnh sản phẩm (không khoá ngoại sang `core`).
    sizeChartFileId: uuid('size_chart_file_id'),
    // Thuộc tính gắn ảnh (#340): trục mà mỗi giá trị mang một ảnh phân loại; null là chưa chọn. Service chỉ nhận trục
    // của sản phẩm (khoá ngoại bỏ qua RLS).
    imageAttributeId: uuid('image_attribute_id').references(() => attributes.id),
    // Xuất xứ (mã ISO 3166-1 alpha-2) và thương hiệu dùng chung mọi sàn (#340); adapter sàn tự đổi sang giá trị của sàn.
    originCountry: text('origin_country'),
    brand: text('brand'),
    ...timestamps,
    ...version,
  },
  (t) => [
    // Tên không trùng trên mọi sản phẩm của công ty, kể cả sản phẩm mọi SKU đã lưu trữ (#204 D4, thay B1 của #12).
    uniqueIndex('products_company_lower_name_uq').on(t.companyId, sql`lower(${t.name})`),
    uniqueIndex('products_company_code_uq').on(t.companyId, t.code),
    index().on(t.groupId),
    // Đích của khoá ngoại ghép `pavi_product_fk` (#340, migration `*_anh-phan-loai-rls`).
    unique('products_id_image_attribute_uq').on(t.id, t.imageAttributeId),
    check('products_origin_country', sql`${t.originCountry} is null or ${t.originCountry} ~ '^[A-Z]{2}$'`),
    check('products_brand_length', sql`${t.brand} is null or char_length(${t.brand}) <= 100`),
  ],
);

/**
 * Ảnh sản phẩm theo thứ tự, `position` 0 là ảnh đại diện (#303); `file_id` ở module files, không đặt khoá ngoại chéo
 * schema. Mỗi vị trí một ảnh; `PUT` thay toàn bộ bằng xoá rồi chèn trong một giao dịch.
 */
export const productImages = catalogSchema.table(
  'product_images',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    fileId: uuid('file_id').notNull(),
    position: integer('position').notNull(),
    ...timestamps,
    ...version,
  },
  (t) => [
    index().on(t.productId),
    index().on(t.fileId),
    uniqueIndex('product_images_product_position_uq').on(t.productId, t.position),
    check('product_images_position_nonneg', sql`${t.position} >= 0`),
  ],
);

/**
 * Ảnh phân loại theo giá trị của thuộc tính gắn ảnh (#340, Documents/19 §3.2): áo 3 màu × 4 size có 3 dòng. Hai khoá
 * ngoại ghép `pavi_product_fk` `(product_id, attribute_id) → products(id, image_attribute_id)` và `pavi_value_fk`
 * `(attribute_value_id, attribute_id) → attribute_values(id, attribute_id)` viết ở migration `--custom`
 * `*_anh-phan-loai-rls` (drizzle-kit sinh khoá ngoại trước unique đích, db/CLAUDE.md). `file_id` ở module files, không
 * khoá ngoại chéo schema.
 */
export const productAttributeValueImages = catalogSchema.table(
  'product_attribute_value_images',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    productId: uuid('product_id').notNull(),
    attributeId: uuid('attribute_id').notNull(),
    attributeValueId: uuid('attribute_value_id').notNull(),
    fileId: uuid('file_id').notNull(),
    ...timestamps,
    ...version,
  },
  (t) => [unique('pavi_product_value_uq').on(t.productId, t.attributeValueId), index().on(t.fileId)],
);

/** Trạng thái kinh doanh của SKU (Documents/21 mục 17, 25 §5.1). SKU mới luôn `selling`. */
export const businessStatus = catalogSchema.enum('business_status', ['selling', 'paused', 'discontinued', 'archived']);

/**
 * Biến thể (SKU); SKU không cấp lại kể cả sau khi lưu trữ (Documents/21 P5). Giá chuẩn, giá muốn thực nhận và biên
 * tối thiểu là đầu vào của bộ lọc giá theo sàn (25 §6.2); cân nặng, kích thước sàn dùng để tính phí ship.
 * `source_request_line_id` là dòng đề nghị nhập sinh ra SKU (purchasing, không đặt khoá ngoại chéo module con).
 */
export const productVariants = catalogSchema.table(
  'product_variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    sku: text('sku').notNull(),
    businessStatus: businessStatus('business_status').notNull().default('selling'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    standardPrice: money('standard_price'),
    targetNetPrice: money('target_net_price'),
    minMarginPct: numeric('min_margin_pct', { precision: 5, scale: 2 }),
    weightG: integer('weight_g'),
    lengthMm: integer('length_mm'),
    widthMm: integer('width_mm'),
    heightMm: integer('height_mm'),
    sourceRequestLineId: uuid('source_request_line_id'),
    ...timestamps,
    ...version,
  },
  (t) => [
    unique().on(t.companyId, t.sku),
    index().on(t.productId),
    check('product_variants_archived', sql`(${t.businessStatus} = 'archived') = (${t.archivedAt} is not null)`),
    check('product_variants_prices', sql`${t.standardPrice} >= 0 and ${t.targetNetPrice} >= 0`),
    // Cùng trần với `domain/measure.ts` (Documents/21 §17.5, #434); số viết thẳng vì giá trị nội suy vào `sql` thành tham số.
    check(
      'product_variants_dimensions',
      sql`${t.weightG} between 1 and 50000 and ${t.lengthMm} between 1 and 2000 and ${t.widthMm} between 1 and 2000 and ${t.heightMm} between 1 and 2000`,
    ),
    // `seller_sku` của TikTok tối đa 50 ký tự (Documents/21 mục 5.2).
    check('product_variants_sku_length', sql`char_length(${t.sku}) <= 50`),
  ],
);

/** Tổ hợp giá trị của biến thể; `position` giữ thứ tự thuộc tính để ghép {VAL} và nhãn (D8). */
export const variantAttributeValues = catalogSchema.table(
  'variant_attribute_values',
  {
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id),
    attributeValueId: uuid('attribute_value_id')
      .notNull()
      .references(() => attributeValues.id),
    position: integer('position').notNull(),
    companyId: uuid('company_id').notNull(),
    ...timestamps,
    ...version,
  },
  (t) => [
    primaryKey({ columns: [t.variantId, t.attributeValueId] }),
    index().on(t.attributeValueId),
    // Tối đa hai trục phân loại (25 §5.4); `position` đếm từ 0.
    check('variant_attribute_values_position', sql`${t.position} in (0, 1)`),
  ],
);
