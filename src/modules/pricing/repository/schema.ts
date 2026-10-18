import { sql } from 'drizzle-orm';
import { check, index, pgSchema, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { money, timestamps, version } from '../../../shared/db/columns.ts';

// Mọi bảng của module `pricing` khai báo trong schema này.
export const pricingSchema = pgSchema('pricing');

export const pricelistType = pricingSchema.enum('pricelist_type', ['standard', 'channel']);

/**
 * Bảng giá: mỗi công ty đúng một bảng chuẩn (G2), mỗi gian hàng tối đa một bảng (G3, D29).
 * `shop_id` ở module channel, không đặt khoá ngoại chéo schema.
 */
export const pricelists = pricingSchema.table(
  'pricelists',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    name: text('name').notNull(),
    type: pricelistType('type').notNull(),
    shopId: uuid('shop_id').unique(),
    ...timestamps,
    ...version,
  },
  (t) => [
    uniqueIndex('pricelists_one_standard_per_company').on(t.companyId).where(sql`${t.type} = 'standard'`),
    check('pricelists_shop_matches_type', sql`(${t.type} = 'channel') = (${t.shopId} is not null)`),
  ],
);

/** Giá của biến thể trong một bảng giá; một biến thể một giá mỗi bảng (19-D33). `variant_id` ở catalog. */
export const pricelistItems = pricingSchema.table(
  'pricelist_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    pricelistId: uuid('pricelist_id')
      .notNull()
      .references(() => pricelists.id),
    variantId: uuid('variant_id').notNull(),
    price: money('price').notNull(),
    ...timestamps,
    ...version,
  },
  (t) => [
    unique().on(t.pricelistId, t.variantId),
    index().on(t.variantId),
    check('pricelist_items_price_not_negative', sql`${t.price} >= 0`),
  ],
);
