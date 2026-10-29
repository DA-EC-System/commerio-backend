import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { toKafkaMessage } from '#src/modules/core/platform/service/outbox/relay.ts';

// Message relay gửi lên Kafka từ một dòng outbox (D4): không Kafka, không DB.
describe('toKafkaMessage', () => {
  it('envelope mang sequence = id dòng outbox để consumer bỏ sự kiện cũ tới muộn', () => {
    const row = {
      id: 42,
      eventId: randomUUID(),
      companyId: randomUUID(),
      type: 'inventory.below_threshold',
      topic: 'commerio.inventory',
      key: randomUUID(),
      payload: { available: 1 },
      createdAt: new Date('2026-10-19T03:00:00Z'),
      publishedAt: null,
    };

    const message = toKafkaMessage(row);

    expect(message.key).toBe(row.key);
    expect(message.headers).toEqual({ type: row.type, eventId: row.eventId });
    expect(JSON.parse(message.value)).toEqual({
      eventId: row.eventId,
      type: row.type,
      companyId: row.companyId,
      aggregateId: row.key,
      occurredAt: '2026-10-19T03:00:00.000Z',
      sequence: 42,
      payload: row.payload,
    });
  });
});
