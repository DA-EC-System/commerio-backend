// Đẩy lại sự kiện từ DLQ về topic gốc (Documents/21 V39). Chạy:
//   node --env-file=.env src/modules/core/platform/service/outbox/replay-dlq.ts <topic>.dlq [--dry-run]
// Đọc từ chỗ lần đẩy trước dừng tới offset cuối lúc bắt đầu. eventId giữ nguyên, nên consumer đã xử lý sự kiện
// đó (ở group khác) sẽ bỏ qua nhờ processed_events; consumer `instance` (realtime) thì nhận lại.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createKafka, createProducer, type IHeaders } from './kafka.ts';
import { type OutboxOptions, outboxOptions } from './runtime.ts';

/** Trả số message đã đẩy (hoặc sẽ đẩy, khi `dryRun`). */
export async function replayDlq(options: OutboxOptions, dlqTopic: string, { dryRun = false } = {}): Promise<number> {
  if (!dlqTopic.endsWith('.dlq')) throw new Error(`${dlqTopic} không phải topic DLQ`);
  const kafka = createKafka(options);
  const groupId = dryRun ? `${options.topicPrefix}.dlq-replay-thu-${randomUUID()}` : `${options.topicPrefix}.dlq-replay`;

  // Mỗi partition: đọc từ offset đã commit của group (chưa có thì từ đầu) tới `high` lúc bắt đầu.
  const admin = kafka.admin();
  await admin.connect();
  const ends = new Map<number, number>();
  try {
    const committed = await admin.fetchOffsets({ groupId, topics: [dlqTopic] });
    const from = new Map(committed[0]?.partitions.map((p) => [p.partition, Number(p.offset)]) ?? []);
    for (const { partition, low, high } of await admin.fetchTopicOffsets(dlqTopic)) {
      const start = Math.max(from.get(partition) ?? -1, Number(low));
      if (start < Number(high)) ends.set(partition, Number(high));
    }
  } finally {
    await admin.disconnect();
  }
  if (ends.size === 0) return 0;

  const producer = createProducer(kafka, options);
  // Commit tay đúng `high` lúc bắt đầu của từng partition khi xong: message vào DLQ trong lúc chạy để lần sau.
  const consumer = kafka.consumer({ kafkaJS: { groupId, fromBeginning: true, autoCommit: false } });
  const expected = dlqTopic.slice(0, -'.dlq'.length);
  const targets = new Map(ends);
  let count = 0;
  let skipped = 0;
  await producer.connect();
  await consumer.connect();
  try {
    await consumer.subscribe({ topics: [dlqTopic] });
    await consumer.run({
      eachMessage: async ({ partition, message }) => {
        const end = ends.get(partition);
        if (end === undefined || Number(message.offset) >= end) return;
        const original = message.headers?.['x-original-topic']?.toString();
        if (original === expected) {
          const headers: IHeaders = Object.fromEntries(
            Object.entries(message.headers ?? {}).filter(([name]) => !name.startsWith('x-')),
          );
          if (!dryRun) await producer.send({ topic: expected, messages: [{ key: message.key, value: message.value, headers }] });
          count++;
        } else {
          skipped++;
          console.warn(`Bỏ qua ${partition}:${message.offset}: x-original-topic ${original ?? '(trống)'} khác ${expected}`);
        }
        if (Number(message.offset) === end - 1) ends.delete(partition);
      },
    });
    // Broker chết giữa chừng thì client giao lại mãi: bỏ cuộc sau 5 phút, chưa commit gì nên chạy lại an toàn.
    const deadline = Date.now() + 5 * 60_000;
    while (ends.size > 0) {
      if (Date.now() > deadline) throw new Error(`Đẩy lại ${dlqTopic} quá 5 phút, đã đẩy ${count}; chạy lại sau`);
      await sleep(100);
    }
    if (!dryRun) {
      await consumer.commitOffsets(
        [...targets].map(([partition, end]) => ({ topic: dlqTopic, partition, offset: String(end) })),
      );
    }
    if (skipped > 0) console.warn(`Bỏ qua ${skipped} message không đúng topic gốc`);
  } finally {
    await consumer.disconnect();
    await producer.disconnect();
  }
  return count;
}

if (import.meta.main) {
  const [topic, flag] = process.argv.slice(2);
  if (!topic) {
    console.error('Cách dùng: node --env-file=.env src/modules/core/platform/service/outbox/replay-dlq.ts <topic>.dlq [--dry-run]');
    process.exit(2);
  }
  const dryRun = flag === '--dry-run';
  const count = await replayDlq(outboxOptions(), topic, { dryRun });
  console.log(`${dryRun ? 'Sẽ đẩy lại' : 'Đã đẩy lại'} ${count} sự kiện từ ${topic}`);
  process.exit(0);
}
