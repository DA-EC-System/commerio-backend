// Hộp thư của gian hàng bị xoá (#398). Chạy trong giao dịch, `withCompany` của bên gọi (channel).
import { eq, inArray } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { conversationNotes, conversations, conversationTags, messageChannels, messages } from './schema.ts';

/**
 * Xoá kênh nhắn tin có `shop_id` của gian hàng, con trước cha: nhãn gắn, ghi chú, tin nhắn của hội thoại → hội thoại →
 * kênh. Bảng `tags` theo công ty nên giữ. Trả số kênh đã xoá.
 */
export async function purgeShopInbox(shopId: string): Promise<number> {
  const db = getDb();
  const channels = await db.select({ id: messageChannels.id }).from(messageChannels).where(eq(messageChannels.shopId, shopId));
  if (!channels.length) return 0;
  const channelIds = channels.map((c) => c.id);
  const convs = await db.select({ id: conversations.id }).from(conversations).where(inArray(conversations.messageChannelId, channelIds));
  const convIds = convs.map((c) => c.id);
  if (convIds.length) {
    await db.delete(conversationTags).where(inArray(conversationTags.conversationId, convIds));
    await db.delete(conversationNotes).where(inArray(conversationNotes.conversationId, convIds));
    await db.delete(messages).where(inArray(messages.conversationId, convIds));
    await db.delete(conversations).where(inArray(conversations.id, convIds));
  }
  const deleted = await db.delete(messageChannels).where(inArray(messageChannels.id, channelIds)).returning({ id: messageChannels.id });
  return deleted.length;
}
