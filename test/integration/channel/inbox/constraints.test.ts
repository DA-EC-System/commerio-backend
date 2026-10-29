import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { testPool } from '../../helpers/db.ts';

const insertChannel = (companyId: string, kind: string, externalAccountId: string) =>
  testPool().query<{ id: string }>(
    `insert into channel.message_channels (company_id, kind, external_account_id, display_name)
     values ($1, $2, $3, 'Kênh thử') returning id`,
    [companyId, kind, externalAccountId],
  );

// Hộp thư hợp nhất (ERD mở rộng, plan chuẩn bị A9; AC-9).
describe('ràng buộc bảng inbox (AC-9)', () => {
  it('một tài khoản ngoài một kênh mỗi loại; hai loại kênh trùng mã tài khoản thì được', async () => {
    const company = randomUUID();
    const account = randomUUID();
    await insertChannel(company, 'messenger', account);
    await expect(insertChannel(company, 'messenger', account)).rejects.toThrow(
      /message_channels_company_id_kind_external_account_id_unique/,
    );
    await expect(insertChannel(company, 'zalo_oa', account)).resolves.toBeDefined();
  });

  it('tin nhắn trùng mã ngoài trong một công ty bị từ chối (đồng bộ lặp)', async () => {
    const company = randomUUID();
    const channel = (await insertChannel(company, 'email', randomUUID())).rows[0]!.id;
    const conversation = await testPool().query<{ id: string }>(
      'insert into channel.conversations (company_id, message_channel_id) values ($1, $2) returning id',
      [company, channel],
    );
    const insertMessage = (externalId: string) =>
      testPool().query(
        `insert into channel.messages (company_id, conversation_id, external_message_id, direction, type, content)
         values ($1, $2, $3, 'inbound', 'text', '{"text":"Chào shop"}')`,
        [company, conversation.rows[0]!.id, externalId],
      );
    await insertMessage('m-1');
    await expect(insertMessage('m-1')).rejects.toThrow(/messages_company_id_external_message_id_unique/);
  });
});
