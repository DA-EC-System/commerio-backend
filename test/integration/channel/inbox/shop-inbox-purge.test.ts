import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { purgeShopInbox } from '#src/modules/channel/inbox/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';

// #398: xoá gian hàng đã ngắt xoá kênh hộp thư của gian hàng cùng hội thoại, tin nhắn, ghi chú, nhãn gắn; bảng nhãn
// (theo công ty) và kênh khác giữ nguyên.

const db = testPool();
const count = async (sql: string, id: string) => Number((await db.query<{ n: string }>(sql, [id])).rows[0]!.n);

/** Kênh có một hội thoại kèm tin nhắn, ghi chú, nhãn `tagId`; trả id kênh và hội thoại. */
async function channelWithConversation(companyId: string, shopId: string | null, tagId: string) {
  const ch = await db.query<{ id: string }>(
    `insert into channel.message_channels (company_id, kind, external_account_id, display_name, shop_id)
     values ($1, 'tiktok_chat', $2, 'Chat sàn', $3) returning id`,
    [companyId, randomUUID(), shopId],
  );
  const channelId = ch.rows[0]!.id;
  const conv = await db.query<{ id: string }>(
    'insert into channel.conversations (company_id, message_channel_id) values ($1, $2) returning id',
    [companyId, channelId],
  );
  const conversationId = conv.rows[0]!.id;
  await db.query(
    `insert into channel.messages (company_id, conversation_id, direction, type, content) values ($1, $2, 'inbound', 'text', '{"text":"Chào shop"}')`,
    [companyId, conversationId],
  );
  await db.query('insert into channel.conversation_notes (company_id, conversation_id, author_id, body) values ($1, $2, $3, $4)', [
    companyId,
    conversationId,
    randomUUID(),
    'Khách hỏi size',
  ]);
  await db.query('insert into channel.conversation_tags (company_id, conversation_id, tag_id) values ($1, $2, $3)', [companyId, conversationId, tagId]);
  return { channelId, conversationId };
}

describe('xoá hộp thư của gian hàng (#398)', () => {
  it('xoá kênh của gian hàng và mọi thứ của hội thoại, giữ kênh khác và nhãn', async () => {
    const { companyId } = await createCompany();
    const tag = await db.query<{ id: string }>("insert into channel.tags (company_id, name) values ($1, 'VIP') returning id", [companyId]);
    const tagId = tag.rows[0]!.id;
    const shopId = randomUUID();
    const mine = await channelWithConversation(companyId, shopId, tagId);
    const other = await channelWithConversation(companyId, null, tagId);

    expect(await withCompany(companyId, () => purgeShopInbox(shopId))).toBe(1);

    expect(await count('select count(*) as n from channel.message_channels where id = $1', mine.channelId)).toBe(0);
    for (const table of ['messages', 'conversation_notes', 'conversation_tags']) {
      expect(await count(`select count(*) as n from channel.${table} where conversation_id = $1`, mine.conversationId)).toBe(0);
      expect(await count(`select count(*) as n from channel.${table} where conversation_id = $1`, other.conversationId)).toBe(1);
    }
    expect(await count('select count(*) as n from channel.conversations where id = $1', mine.conversationId)).toBe(0);
    expect(await count('select count(*) as n from channel.message_channels where id = $1', other.channelId)).toBe(1);
    expect(await count('select count(*) as n from channel.tags where id = $1', tagId)).toBe(1);
  });
});
