import { boolean, pgSchema, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { timestamps, version } from '../../../shared/db/columns.ts';

// Mọi bảng của module `platform` khai báo trong schema này.
export const platformSchema = pgSchema('platform');

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
