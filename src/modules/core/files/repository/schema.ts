import { sql } from 'drizzle-orm';
import { bigint, check, index, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { timestamps, version } from '../../../../shared/db/columns.ts';
import { FILE_PURPOSES } from '../domain/upload-rules.ts';

// Mọi bảng của module `files` khai báo trong schema này.
export const filesSchema = pgSchema('core');

/** Mục đích của tệp (Documents/21 §14.3): quyết định kiểu, cỡ cho phép và bucket chứa tệp. */
export const filePurpose = filesSchema.enum('file_purpose', FILE_PURPOSES);

/**
 * Thông tin tệp; nội dung tệp nằm ở kho đối tượng (Cloudflare R2 qua API S3) theo `storage_key`. Dòng được tạo lúc
 * cấp vé tải lên (#212), trước khi FE PUT tệp: dòng có mà tệp chưa có trên kho là bình thường. `uploaded_at` ghi lần
 * đầu thấy tệp trên kho (khi gắn vào chứng từ); trống là chưa xác nhận đã PUT xong.
 */
export const files = filesSchema.table(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    storageKey: text('storage_key').notNull().unique(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    purpose: filePurpose('purpose').notNull(),
    uploadedBy: uuid('uploaded_by'),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }),
    ...timestamps,
    ...version,
  },
  (t) => [check('files_size_positive', sql`${t.sizeBytes} > 0`)],
);

export type FileRow = typeof files.$inferSelect;

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
