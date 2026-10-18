import { index, integer, jsonb, pgSchema, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { bytea, timestamps, version } from '../../../shared/db/columns.ts';

// Mọi bảng của module `inbox` khai báo trong schema này.
export const inboxSchema = pgSchema('inbox');

export const messageKind = inboxSchema.enum('message_kind', [
  'messenger',
  'email',
  'zalo_oa',
  'tiktok_chat',
  'shopee_chat',
]);
export const msgDirection = inboxSchema.enum('msg_direction', ['inbound', 'outbound']);
export const sendStatus = inboxSchema.enum('send_status', ['pending', 'sent', 'failed']);

// `shop_id` (channel), `customer_identity_id` (sales), người phụ trách/người gửi (staff) là uuid thường, không khoá
// ngoại chéo schema (19-D1).

/** Kênh nhắn tin đã kết nối (trang Messenger, hộp thư, Zalo OA, chat sàn). Token lưu đã mã hoá. */
export const messageChannels = inboxSchema.table(
  'message_channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    kind: messageKind('kind').notNull(),
    externalAccountId: text('external_account_id').notNull(),
    displayName: text('display_name').notNull(),
    shopId: uuid('shop_id'),
    accessTokenEnc: bytea('access_token_enc'),
    status: text('status'),
    ...timestamps,
    ...version,
  },
  // Thêm `kind` vào khoá của ERD: mã tài khoản của hai nền tảng khác nhau có thể trùng.
  (t) => [unique().on(t.companyId, t.kind, t.externalAccountId)],
);

export const conversations = inboxSchema.table(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    messageChannelId: uuid('message_channel_id')
      .notNull()
      .references(() => messageChannels.id),
    customerIdentityId: uuid('customer_identity_id'),
    assigneeId: uuid('assignee_id'),
    externalConversationId: text('external_conversation_id'),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    unreadCount: integer('unread_count').notNull().default(0),
    replyWindowExpiresAt: timestamp('reply_window_expires_at', { withTimezone: true }),
    ...timestamps,
    ...version,
  },
  (t) => [index().on(t.messageChannelId), index().on(t.assigneeId)],
);

/** Ghi chú nội bộ trên hội thoại, khách không thấy. */
export const conversationNotes = inboxSchema.table(
  'conversation_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    authorId: uuid('author_id').notNull(),
    body: text('body').notNull(),
    ...timestamps,
    ...version,
  },
  (t) => [index().on(t.conversationId)],
);

/** Tin nhắn; tin gửi đi chưa có mã ngoài cho tới khi nền tảng nhận. Chống lặp khi đồng bộ theo mã ngoài. */
export const messages = inboxSchema.table(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    externalMessageId: text('external_message_id'),
    direction: msgDirection('direction').notNull(),
    type: text('type').notNull(),
    content: jsonb('content').notNull(),
    senderId: uuid('sender_id'),
    sendStatus: sendStatus('send_status'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.companyId, t.externalMessageId), index().on(t.conversationId)],
);

export const tags = inboxSchema.table(
  'tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    name: text('name').notNull(),
    color: text('color'),
    ...timestamps,
    ...version,
  },
  (t) => [unique().on(t.companyId, t.name)],
);

export const conversationTags = inboxSchema.table(
  'conversation_tags',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id),
    companyId: uuid('company_id').notNull(),
    ...timestamps,
    ...version,
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.tagId] }), index().on(t.tagId)],
);
