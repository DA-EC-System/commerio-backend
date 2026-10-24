import { bigint, boolean, date, pgSchema, unique, uuid } from 'drizzle-orm/pg-core';
import { money, timestamps, version } from '../../../../shared/db/columns.ts';

// Mọi bảng của module `report` khai báo trong schema này.
export const reportSchema = pgSchema('report');

/** Bản riêng của schema này, cùng giá trị với `sales.order_source` (plan chuẩn bị A5). */
export const orderSource = reportSchema.enum('order_source', ['marketplace', 'inbox', 'manual']);

/**
 * Số liệu theo ngày và gian hàng (V28, D18), dựng lại bằng tính lại từ module nguồn (D7). `shop_id` trống với đơn
 * hộp thư, đơn tạo tay, nên khoá unique coi hai giá trị trống là trùng. `fees_pending`: có đơn chưa đối soát nên phí
 * sàn đang là 0.
 */
export const dailyChannelSummary = reportSchema.table(
  'daily_channel_summary',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    companyId: uuid('company_id').notNull(),
    day: date('day').notNull(),
    source: orderSource('source').notNull(),
    shopId: uuid('shop_id'),
    revenue: money('revenue').notNull().default('0'),
    cashCollected: money('cash_collected').notNull().default('0'),
    platformFee: money('platform_fee').notNull().default('0'),
    paymentFee: money('payment_fee').notNull().default('0'),
    shippingFee: money('shipping_fee').notNull().default('0'),
    cogs: money('cogs').notNull().default('0'),
    profit: money('profit').notNull().default('0'),
    feesPending: boolean('fees_pending').notNull().default(false),
    ...timestamps,
    ...version,
  },
  (t) => [unique().on(t.companyId, t.day, t.source, t.shopId).nullsNotDistinct()],
);
