import { bigint, pgSchema, text, uuid } from 'drizzle-orm/pg-core';
import { timestamps, version } from '../../../shared/db/columns.ts';

// Mọi bảng của module `files` khai báo trong schema này.
export const filesSchema = pgSchema('files');

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
