import { sql } from 'drizzle-orm';
import { check, index, integer, pgSchema, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { timestamps, version } from '../../../shared/db/columns.ts';

// Mọi bảng của module `catalog` khai báo trong schema này.
export const catalogSchema = pgSchema('catalog');

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
    uniqueIndex('products_company_lower_name_uq').on(t.companyId, sql`lower(${t.name})`),
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

/** Biến thể; SKU không cấp lại kể cả sau khi ngừng bán (Documents/21 P5). */
export const productVariants = catalogSchema.table(
  'product_variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    sku: text('sku').notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps,
    ...version,
  },
  (t) => [unique().on(t.companyId, t.sku), index().on(t.productId)],
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
  (t) => [primaryKey({ columns: [t.variantId, t.attributeValueId] }), index().on(t.attributeValueId)],
);
