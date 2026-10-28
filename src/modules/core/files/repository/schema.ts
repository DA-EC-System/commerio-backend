import { bigint, index, pgSchema, text, uuid } from 'drizzle-orm/pg-core';
import { timestamps, version } from '../../../../shared/db/columns.ts';

// Mọi bảng của module `files` khai báo trong schema này.
export const filesSchema = pgSchema('core');

/** Thông tin tệp; nội dung tệp nằm ở kho đối tượng (S3/SeaweedFS) theo `storage_key`. */
export const files = filesSchema.table('files', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull(),
  storageKey: text('storage_key').notNull().unique(),
  fileName: text('file_name').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  uploadedBy: uuid('uploaded_by'),
  ...timestamps,
  ...version,
});

/**
 * Tệp đính kèm của một chứng từ (ảnh phiếu giao, video mở thùng, biên bản; Documents/21 mục 14.3). `entity_type`
 * là tên bảng của chứng từ, vd `goods_receipts`; không khoá ngoại vì chứng từ nằm ở module khác.
 */
export const attachments = filesSchema.table(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    purpose: text('purpose'),
    createdBy: uuid('created_by'),
    ...timestamps,
    ...version,
  },
  (t) => [index().on(t.entityType, t.entityId), index().on(t.fileId)],
);
