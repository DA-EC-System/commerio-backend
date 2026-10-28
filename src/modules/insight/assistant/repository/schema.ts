import {
  index,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { timestamps, version } from '../../../../shared/db/columns.ts';

// Mọi bảng của module `assistant` khai báo trong schema này.
export const assistantSchema = pgSchema('insight');

export const docProcessing = assistantSchema.enum('doc_processing', ['processing', 'ready', 'failed']);

// `file_id` (files), người tải lên (staff), `role_id` (access) là uuid thường, không khoá ngoại chéo schema (19-D1).
// Kiểu `vector` cần extension pgvector, bật ở migration 0012.

/** Tài liệu nội bộ trợ lý AI dùng để trả lời; tách đoạn và tạo embedding ở worker. */
export const documents = assistantSchema.table('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull(),
  fileId: uuid('file_id').notNull(),
  title: text('title').notNull(),
  status: docProcessing('status').notNull().default('processing'),
  uploadedBy: uuid('uploaded_by').notNull(),
  ...timestamps,
  ...version,
});

/** Đoạn tài liệu và embedding 1536 chiều; `role_ids` chép từ `document_roles` để lọc lúc tìm kiếm. */
export const documentChunks = assistantSchema.table(
  'document_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    roleIds: uuid('role_ids').array(),
    embedding: vector('embedding', { dimensions: 1536 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.documentId, t.chunkIndex)],
);

/** Vai trò được hỏi trợ lý về tài liệu này. */
export const documentRoles = assistantSchema.table(
  'document_roles',
  {
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id),
    roleId: uuid('role_id').notNull(),
    companyId: uuid('company_id').notNull(),
    ...timestamps,
    ...version,
  },
  (t) => [primaryKey({ columns: [t.documentId, t.roleId] }), index().on(t.roleId)],
);
