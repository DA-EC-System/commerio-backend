import { sql } from 'drizzle-orm';
import { bigint, boolean, index, jsonb, pgSchema, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { timestamps, version } from '../../../../shared/db/columns.ts';

// Mọi bảng của module `platform` khai báo trong schema này.
export const platformSchema = pgSchema('core');

export const companyStatus = platformSchema.enum('company_status', ['active', 'locked']);

/** Mã phân hệ (giai-phap.tex, bảng phân hệ): 10 luôn bật, 5 tuỳ chọn. */
export const moduleCode = platformSchema.enum('module_code', [
  'platform',
  'identity',
  'catalog',
  'pricing',
  'inventory',
  'sales',
  'fulfillment',
  'finance',
  'payment',
  'notification',
  'purchasing',
  'channel',
  'inbox',
  'assistant',
  'report',
]);

// Bảng chung của nền tảng, không thuộc công ty nào nên không có RLS.
export const companies = platformSchema.table('companies', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  taxCode: text('tax_code').notNull(),
  status: companyStatus('status').notNull().default('active'),
  lockReason: text('lock_reason'),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  ...timestamps,
  ...version,
});

/** Phân hệ đang bật của công ty. Chỉ có dòng cho phân hệ đã bật hoặc từng bật. */
export const companyModules = platformSchema.table(
  'company_modules',
  {
    companyId: uuid('company_id').notNull(),
    moduleCode: moduleCode('module_code').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    // Tài khoản ở module staff, không đặt khoá ngoại chéo module.
    enabledBy: uuid('enabled_by'),
    aiConsentAt: timestamp('ai_consent_at', { withTimezone: true }),
    aiConsentBy: uuid('ai_consent_by'),
    ...timestamps,
    ...version,
  },
  (t) => [primaryKey({ columns: [t.companyId, t.moduleCode] })],
);

/**
 * Outbox (Documents/21 D4, D5): sự kiện ghi cùng giao dịch nghiệp vụ, relay của worker đẩy lên Kafka.
 * `company_id` trống với sự kiện cấp nền tảng. Role ứng dụng chỉ được INSERT (0005), nên `event_id`
 * sinh ở ứng dụng, không dùng RETURNING; relay đọc bằng role chủ bảng.
 */
export const outboxMessages = platformSchema.table(
  'outbox_messages',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    eventId: uuid('event_id').notNull().unique(),
    companyId: uuid('company_id'),
    type: text('type').notNull(),
    topic: text('topic').notNull(),
    key: text('key').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => [index('outbox_messages_unpublished_idx').on(t.id).where(sql`${t.publishedAt} is null`)],
);

/** Sự kiện consumer đã xử lý, chống xử lý trùng (D7). Không thuộc công ty nên không có RLS. */
export const processedEvents = platformSchema.table(
  'processed_events',
  {
    consumer: text('consumer').notNull(),
    eventId: uuid('event_id').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.consumer, t.eventId] })],
);

export const transitionSource = platformSchema.enum('transition_source', ['user', 'marketplace', 'system']);

/**
 * Lịch sử chuyển trạng thái của mọi thực thể có máy trạng thái (N4, Documents/21 mục 14.1: `statusHistory`), chỉ
 * thêm. `entity_type` là tên bảng (vd `packages`), `actor_id` trống khi sàn hoặc hệ thống chuyển. Thực thể nằm ở
 * module khác nên không có khoá ngoại.
 */
export const stateTransitions = platformSchema.table(
  'state_transitions',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    companyId: uuid('company_id').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    fromState: text('from_state'),
    toState: text('to_state').notNull(),
    action: text('action').notNull(),
    actorId: uuid('actor_id'),
    source: transitionSource('source').notNull(),
    reason: text('reason'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.entityType, t.entityId, t.at)],
);
