import { sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { conversations, messageChannels } from './schema.ts';

/** Công ty đang chọn đã có kênh tin nhắn hay hội thoại chưa: có thì không tắt được phân hệ Hộp thư (#152). */
export async function hasInboxData(): Promise<boolean> {
  const [channel] = await getDb().select({ one: sql`1` }).from(messageChannels).limit(1);
  if (channel) return true;
  const [conversation] = await getDb().select({ one: sql`1` }).from(conversations).limit(1);
  return !!conversation;
}
