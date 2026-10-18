import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCompany } from '../helpers/company.ts';
import { startKafka, type TestKafka } from '../platform/outbox/helpers.ts';
import { createHub, type Hub, notificationHandlers } from '#src/modules/notification/index.ts';
import { publishEvent } from '#src/modules/platform/index.ts';
import { type ConsumerRunner, createConsumerRunner } from '#src/modules/platform/service/outbox/consumer.ts';
import { createRelay, type Relay } from '#src/modules/platform/service/outbox/relay.ts';
import { type OutboxOptions, outboxOptions } from '#src/modules/platform/service/outbox/runtime.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { closeServer } from '#src/shared/lifecycle.ts';
import { openStream, startRealtime } from './helpers.ts';

// Luồng thật (AC-2): publishEvent trong giao dịch → relay → Kafka → consumer instance của notification → hub → client SSE.
// Tiền tố topic riêng của file đặt trước khi env.ts được nạp; địa chỉ Kafka chỉ biết sau khi container chạy nên
// truyền qua options. Consumer dựng bằng runner (không qua registerConsumer) để chờ chia partition và dừng được.
vi.hoisted(() => {
  process.env.KAFKA_TOPIC_PREFIX = `n${Math.random().toString(36).slice(2, 10)}`;
});

let kafka: TestKafka;
let options: OutboxOptions;
let relay: Relay;
let runner: ConsumerRunner;
let server: Server;
let url: string;
const seen = new Set<string>();
const hub = createHub();
// Ghi lại sự kiện tới hub để biết consumer đã đọc tới đâu, rồi chuyển tiếp.
const spyHub: Hub = { ...hub, dispatch: (event) => (seen.add(event.eventId), hub.dispatch(event)) };

beforeAll(async () => {
  kafka = await startKafka();
  options = outboxOptions({ brokers: kafka.brokers, pollMs: 100 });
  relay = createRelay(options);
  runner = createConsumerRunner(options, { consumer: 'notification-sse', scope: 'instance', handlers: notificationHandlers(spyHub) });
  await runner.start();
  ({ server, url } = await startRealtime({ hub }));
  // 5 topic (sales, fulfillment, payment, inventory, purchasing) × 3 partition.
  await vi.waitUntil(() => runner.assignment().length === 15, { timeout: 60_000, interval: 200 });
}, 180_000);

afterAll(async () => {
  hub.closeAll();
  await Promise.all([runner?.stop(), relay?.stop(), server && closeServer(server)]);
  await kafka?.stop();
}, 60_000);

async function relayAll() {
  while ((await relay.tick()) !== 0);
}

const orderCreated = (companyId: string, code: string) => {
  const orderId = randomUUID();
  return withCompany(companyId, () =>
    publishEvent({ type: 'sales.order_created', aggregateId: orderId, payload: { orderId, code, source: 'manual', total: '150000.00' } }),
  );
};

describe('outbox → Kafka → realtime → trình duyệt (AC-2, AC-3)', () => {
  it('hai sự kiện của công ty tới cùng một client của công ty đó trong 2 s, đúng id; công ty khác không nhận', async () => {
    const [a, b] = await Promise.all([createCompany(), createCompany()]);
    // Consumer instance đọc từ mới nhất: phát mốc tới khi consumer thấy, rồi mới đo.
    await vi.waitUntil(
      async () => {
        const marker = await orderCreated(b.companyId, 'MOC');
        await relayAll();
        await sleep(300);
        return seen.has(marker);
      },
      { timeout: 60_000, interval: 100 },
    );

    const [clientA, clientB] = await Promise.all([openStream(url, a.ceo.token), openStream(url, b.ceo.token)]);
    expect([clientA.status, clientB.status]).toEqual([200, 200]);
    await Promise.all([clientA, clientB].map((c) => c.until((t) => t.includes('retry:'))));

    const first = await orderCreated(a.companyId, 'DH-1');
    const second = await orderCreated(a.companyId, 'DH-2');
    const committed = performance.now();
    await relayAll();
    await clientA.until((t) => t.includes(`id: ${second}`));
    const elapsed = performance.now() - committed;

    // Đo giờ thật có chủ ý: đây là bằng chứng AC-2 (≤ 2 s); đo trên máy 0,1–0,4 s nên còn dư nhiều cho CI.
    expect(elapsed).toBeLessThan(2_000);
    const text = clientA.text();
    // Hai đơn khác nhau nằm ở partition khác nhau: Kafka chỉ giữ thứ tự trong một đối tượng, nên chỉ kiểm cả hai tới.
    expect(text).toContain(`id: ${first}`);
    expect(text).toContain('event: sales.order_created');
    expect(text).toContain('"total":150000');
    expect(clientB.text()).not.toContain(first);
    clientA.abort();
    clientB.abort();
  }, 120_000);
});
