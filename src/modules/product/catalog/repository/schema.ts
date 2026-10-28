import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
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

/** Danh mục và quy tắc SKU (Documents/21 5.1). Tên không trùng theo chữ thường trong công ty. */
export const categories = catalogSchema.table(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    name: text('name').notNull(),
    skuPattern: text('sku_pattern').notNull(),
    // Số thứ tự cấp cho biến thể kế tiếp của danh mục ({SEQ}).
    skuNextSeq: integer('sku_next_seq').notNull().default(1),
    ...timestamps,
    ...version,
  },
  (t) => [uniqueIndex('categories_company_lower_name_uq').on(t.companyId, sql`lower(${t.name})`)],
);

export const attributes = catalogSchema.table(
  'attributes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    name: text('name').notNull(),
    ...timestamps,
    ...version,
  },
  (t) => [uniqueIndex('attributes_company_lower_name_uq').on(t.companyId, sql`lower(${t.name})`)],
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
    check('attribute_values_code_format', sql`${t.code} ~ '^[A-Z0-9]{1,6}$'`),
  ],
);

/** Sản phẩm; không đổi danh mục sau khi tạo (Documents/21 P6). Xoá là lưu trữ (`archived_at`). */
export const products = catalogSchema.table(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id),
    name: text('name').notNull(),
    description: text('description'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps,
    ...version,
  },
  (t) => [
    // Tên chỉ không trùng giữa sản phẩm chưa lưu trữ: tên của sản phẩm đã lưu trữ dùng lại được (#12 B1).
    uniqueIndex('products_company_lower_name_uq')
      .on(t.companyId, sql`lower(${t.name})`)
      .where(sql`${t.archivedAt} is null`),
    index().on(t.categoryId),
  ],
);

/** Ảnh sản phẩm theo thứ tự; `file_id` ở module files, không đặt khoá ngoại chéo schema. */
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
  (t) => [index().on(t.productId), index().on(t.fileId)],
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
    check(
      'product_variants_dimensions',
      sql`${t.weightG} > 0 and ${t.lengthMm} > 0 and ${t.widthMm} > 0 and ${t.heightMm} > 0`,
    ),
  ],
);

/** Danh mục và thuộc tính bắt buộc theo sàn của một sản phẩm (25 §5.2); cây danh mục mỗi sàn một khác. */
export const productChannelSpecs = catalogSchema.table(
  'product_channel_specs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    platform: text('platform').notNull(),
    externalCategoryId: text('external_category_id').notNull(),
    attributes: jsonb('attributes').notNull().default({}),
    ...timestamps,
    ...version,
  },
  (t) => [unique().on(t.productId, t.platform)],
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
