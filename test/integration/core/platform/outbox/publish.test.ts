import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { publishEvent } from '#src/modules/core/platform/index.ts';
import { cleanupOutbox } from '#src/modules/core/platform/service/outbox/relay.ts';
import { inTransaction, withCompany } from '#src/shared/db/client.ts';
import { testPool } from '../../../helpers/db.ts';

// Ghi sự kiện vào outbox (AC-1, S1, S2) và dọn dòng cũ (AC-10). Không cần Kafka.
const belowThreshold = (variantId = randomUUID()) =>
  ({ type: 'inventory.below_threshold', aggregateId: variantId, payload: { variantId, available: 1, minQty: 5 } }) as const;

const rowOf = async (eventId: string) =>
  (
    await testPool().query(
      'select company_id, type, topic, key, payload, published_at from platform.outbox_messages where event_id = $1',
      [eventId],
    )
  ).rows;

describe('publishEvent (AC-1)', () => {
  it('giao dịch commit thì có đúng một dòng chưa gửi, mang công ty và topic của module', async () => {
    const company = randomUUID();
    const event = belowThreshold();
    const eventId = await withCompany(company, () => publishEvent(event));
    expect(await rowOf(eventId)).toEqual([
      {
        company_id: company,
        type: 'inventory.below_threshold',
        topic: 'commerio.inventory',
        key: event.aggregateId,
        payload: event.payload,
        published_at: null,
      },
    ]);
  });

  it('giao dịch rollback thì không còn dòng nào', async () => {
    let eventId = '';
    await expect(
      withCompany(randomUUID(), async () => {
        eventId = await publishEvent(belowThreshold());
        throw new Error('nghiệp vụ lỗi');
      }),
    ).rejects.toThrow('nghiệp vụ lỗi');
    expect(eventId).not.toBe('');
    expect(await rowOf(eventId)).toEqual([]);
  });
});

describe('publishEvent: gọi sai chỗ (S1, S2)', () => {
  it('ngoài giao dịch thì ném lỗi', async () => {
    await expect(publishEvent(belowThreshold())).rejects.toThrow(/withCompany/);
  });

  it('trong giao dịch không thuộc công ty thì ném lỗi', async () => {
    await expect(inTransaction(() => publishEvent(belowThreshold()))).rejects.toThrow(/withCompany/);
  });

  it('payload sai schema làm rollback cả giao dịch nghiệp vụ', async () => {
    const company = randomUUID();
    let first = '';
    await expect(
      withCompany(company, async () => {
        first = await publishEvent(belowThreshold());
        // @ts-expect-error cố ý sai kiểu
        await publishEvent({ type: 'inventory.below_threshold', aggregateId: 'x', payload: { variantId: 'x' } });
      }),
    ).rejects.toThrow(/inventory\.below_threshold/);
    expect(await rowOf(first)).toEqual([]);
  });
});

describe('dọn outbox (AC-10)', () => {
  const insert = async (prefix: string, publishedAgo: string | null, createdAgo: string) => {
    const eventId = randomUUID();
    await testPool().query(
      `insert into platform.outbox_messages (event_id, company_id, type, topic, key, payload, created_at, published_at)
       values ($1, $2, 'inventory.below_threshold', $3, 'k', '{}', now() - $4::interval,
               case when $5::interval is null then null else now() - $5::interval end)`,
      [eventId, randomUUID(), `${prefix}.inventory`, createdAgo, publishedAgo],
    );
    return eventId;
  };

  it('xoá dòng đã gửi quá 7 ngày của tiền tố mình, giữ dòng chưa gửi và dòng của tiền tố khác', async () => {
    const prefix = `t${randomUUID().slice(0, 8)}`;
    const old = await insert(prefix, '8 days', '8 days');
    const recent = await insert(prefix, '6 days', '6 days');
    const pending = await insert(prefix, null, '8 days');
    const other = await insert(`${prefix}x`, '8 days', '8 days');
    await cleanupOutbox(prefix);
    expect(await rowOf(old)).toEqual([]);
    expect(await rowOf(recent)).toHaveLength(1);
    expect(await rowOf(pending)).toHaveLength(1);
    expect(await rowOf(other)).toHaveLength(1);
  });

  it('xoá processed_events quá 7 ngày', async () => {
    const [oldId, newId] = [randomUUID(), randomUUID()];
    await testPool().query(
      `insert into platform.processed_events (consumer, event_id, processed_at)
       values ('don', $1, now() - interval '8 days'), ('don', $2, now() - interval '6 days')`,
      [oldId, newId],
    );
    await cleanupOutbox(`t${randomUUID().slice(0, 8)}`);
    const { rows } = await testPool().query(
      "select event_id from platform.processed_events where consumer = 'don' and event_id = any($1)",
      [[oldId, newId]],
    );
    expect(rows).toEqual([{ event_id: newId }]);
  });
});
