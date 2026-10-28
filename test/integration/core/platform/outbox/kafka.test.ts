import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { testPool } from '../../../helpers/db.ts';
import type { Relay } from '#src/modules/core/platform/service/outbox/relay.ts';
import type { ModuleContext } from '#src/shared/module.ts';
import { startKafka, type TestKafka } from './helpers.ts';

// Outbox → relay → Kafka → consumer trên PostgreSQL và Kafka thật (#38 AC-2..AC-7, AC-9, AC-10, S3, S4).
// env.ts đọc biến môi trường một lần lúc import, nên mọi code của src nạp động sau khi đặt địa chỉ Kafka và tiền tố
// topic riêng của file này (relay chỉ đụng dòng của tiền tố mình, plan A0).
const prefix = `t${randomUUID().slice(0, 8)}`;
let kafka: TestKafka;
let src: Awaited<ReturnType<typeof load>>;
const stops: (() => Promise<void>)[] = [];

async function load() {
  return {
    platform: await import('#src/modules/core/platform/index.ts'),
    relay: await import('#src/modules/core/platform/service/outbox/relay.ts'),
    consumer: await import('#src/modules/core/platform/service/outbox/consumer.ts'),
    kafka: await import('#src/modules/core/platform/service/outbox/kafka.ts'),
    runtime: await import('#src/modules/core/platform/service/outbox/runtime.ts'),
    replay: await import('#src/modules/core/platform/service/outbox/replay-dlq.ts'),
    db: await import('#src/shared/db/client.ts'),
    drizzle: await import('drizzle-orm'),
  };
}

beforeAll(async () => {
  kafka = await startKafka();
  process.env.KAFKA_BROKERS = kafka.brokers.join(',');
  process.env.KAFKA_TOPIC_PREFIX = prefix;
  src = await load();
}, 120_000);

afterAll(async () => {
  await Promise.all(stops.map((stop) => stop()));
  await kafka?.stop();
}, 60_000);

const options = (over = {}) => src.runtime.outboxOptions({ pollMs: 100, retryDelaysMs: [50, 50, 50], ...over });

const waitFor = (check: () => boolean | Promise<boolean>, timeout = 30_000) =>
  vi.waitUntil(check, { timeout, interval: 100 });

/** Đọc một topic từ đầu bằng group riêng tới khi `done`. */
async function readTopic(topic: string, done: (messages: { headers: Record<string, string> }[]) => boolean) {
  const consumer = src.kafka.createKafka(options()).consumer({ kafkaJS: { groupId: `doc-${randomUUID()}`, fromBeginning: true } });
  const messages: { key: string; value: string; headers: Record<string, string> }[] = [];
  await consumer.connect();
  await consumer.subscribe({ topics: [topic] });
  await consumer.run({
    eachMessage: async ({ message }) => {
      const headers = Object.fromEntries(Object.entries(message.headers ?? {}).map(([k, v]) => [k, String(v)]));
      messages.push({ key: String(message.key), value: String(message.value), headers });
    },
  });
  try {
    await waitFor(() => done(messages));
  } finally {
    await consumer.disconnect();
  }
  return messages;
}

async function relayAll(relay: { tick(): Promise<number | 'busy'> }) {
  while ((await relay.tick()) !== 0);
}

const unpublished = async (eventIds: string[]) =>
  Number(
    (
      await testPool().query(
        'select count(*) from core.outbox_messages where event_id = any($1) and published_at is null',
        [eventIds],
      )
    ).rows[0].count,
  );

const publishStock = (companyId: string, variantId: string, onHand: number) =>
  src.db.withCompany(companyId, () =>
    src.platform.publishEvent({
      type: 'inventory.stock_changed',
      aggregateId: variantId,
      payload: { variantId, onHand, reserved: 0, available: onHand },
    }),
  );

const publishBelow = (companyId: string, variantId: string, minQty: number) =>
  src.db.withCompany(companyId, () =>
    src.platform.publishEvent({
      type: 'inventory.below_threshold',
      aggregateId: variantId,
      payload: { variantId, available: 0, minQty },
    }),
  );

let relay: Relay;
beforeAll(() => {
  relay = src.relay.createRelay(options());
  stops.push(() => relay.stop());
});

describe('relay', () => {
  it('gửi mọi dòng chưa gửi của mọi công ty với key = aggregateId, đúng thứ tự từng key, rồi đánh dấu (AC-2, AC-10)', async () => {
    const companies = [randomUUID(), randomUUID()];
    const variants = Array.from({ length: 6 }, () => randomUUID());
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) ids.push(await publishStock(companies[i % 2]!, variants[i % 6]!, i));
    // Dòng không thuộc công ty nào (ghi bằng role chủ bảng): relay vẫn đọc được.
    const platformRow = randomUUID();
    const v = randomUUID();
    await testPool().query(
      `insert into core.outbox_messages (event_id, type, topic, key, payload)
       values ($1, 'inventory.stock_changed', $2, $3, $4)`,
      [platformRow, `${prefix}.inventory`, v, { variantId: v, onHand: 1, reserved: 0, available: 1 }],
    );
    ids.push(platformRow);

    await relayAll(relay);
    expect(await unpublished(ids)).toBe(0);

    const messages = await readTopic(`${prefix}.inventory`, (m) => m.filter((x) => ids.includes(x.headers.eventId!)).length >= 61);
    const ours = messages.filter((m) => ids.includes(m.headers.eventId!));
    expect(ours).toHaveLength(61);
    for (const variant of variants) {
      const onHands = ours.filter((m) => m.key === variant).map((m) => JSON.parse(m.value).payload.onHand as number);
      expect(onHands).toEqual([...onHands].sort((a, b) => a - b));
      expect(onHands).toHaveLength(10);
    }
    const first = ours.find((m) => m.headers.eventId === ids[0])!;
    expect(JSON.parse(first.value)).toMatchObject({
      eventId: ids[0],
      type: 'inventory.stock_changed',
      companyId: companies[0],
      aggregateId: variants[0],
      payload: { variantId: variants[0], onHand: 0 },
    });
  }, 90_000);

  it('relay khác đang giữ khoá thì lượt này bỏ qua, không gửi gì (S4)', async () => {
    const id = await publishStock(randomUUID(), randomUUID(), 1);
    const holder = await testPool().connect();
    try {
      await holder.query('begin');
      await holder.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`platform.outbox_relay:${prefix}`]);
      expect(await relay.tick()).toBe('busy');
      expect(await unpublished([id])).toBe(1);
    } finally {
      await holder.query('rollback');
      holder.release();
    }
    await relayAll(relay);
    expect(await unpublished([id])).toBe(0);
  }, 60_000);
});

describe('consumer shared', () => {
  it('handler chạy dưới withCompany của sự kiện, chỉ một lần dù sự kiện tới hai lần (AC-4, AC-6, S3)', async () => {
    const { sql } = src.drizzle;
    const seen: { eventId: string; companyId: string | null; role: string }[] = [];
    const runner = src.consumer.createConsumerRunner(options(), {
      consumer: 'e2e',
      scope: 'shared',
      handlers: new Map([
        [
          'inventory.below_threshold',
          async (event) => {
            const role = await src.db.getDb().execute<{ r: string }>(sql`select current_user as r`);
            seen.push({ eventId: event.eventId, companyId: src.db.currentCompanyId(), role: role.rows[0]!.r });
            const payload = event.payload as { variantId: string };
            // Tác động nghiệp vụ trong cùng giao dịch: phát tiếp một sự kiện.
            await src.platform.publishEvent({
              type: 'inventory.stock_changed',
              aggregateId: payload.variantId,
              payload: { variantId: payload.variantId, onHand: 0, reserved: 0, available: 0 },
            });
          },
        ],
      ]),
    });
    stops.push(() => runner.stop());
    await runner.start();

    const company = randomUUID();
    const variant = randomUUID();
    const eventId = await publishBelow(company, variant, 5);
    await relayAll(relay);
    await waitFor(() => seen.length === 1);
    expect(seen[0]).toEqual({ eventId, companyId: company, role: 'commerio_app' });

    // Giao lại đúng message đó (như worker chết sau khi gửi, trước khi đánh dấu), rồi một sự kiện mốc cùng key.
    const row = (await testPool().query('select * from core.outbox_messages where event_id = $1', [eventId])).rows[0];
    const producer = src.kafka.createProducer(src.kafka.createKafka(options()), options());
    await producer.connect();
    await producer.send({
      topic: `${prefix}.inventory`,
      messages: [
        src.relay.toKafkaMessage({
          // pg trả bigint dạng chuỗi; relay thật đọc qua Drizzle (mode number) nên sequence là số.
          id: Number(row.id),
          eventId,
          companyId: company,
          type: row.type,
          topic: row.topic,
          key: row.key,
          payload: row.payload,
          createdAt: row.created_at,
          publishedAt: row.published_at,
        }),
      ],
    });
    await producer.disconnect();
    const marker = await publishBelow(company, variant, 6);
    await relayAll(relay);
    // Chờ giao dịch của handler commit (dấu processed_events), không chỉ chờ handler được gọi.
    await waitFor(async () => {
      const r = await testPool().query(
        "select 1 from core.processed_events where consumer = 'e2e' and event_id = $1",
        [marker],
      );
      return r.rowCount === 1;
    });

    expect(seen.filter((s) => s.eventId === eventId)).toHaveLength(1);
    const processed = await testPool().query(
      "select count(*) from core.processed_events where consumer = 'e2e' and event_id = $1",
      [eventId],
    );
    expect(Number(processed.rows[0].count)).toBe(1);
    const effects = await testPool().query(
      "select count(*) from core.outbox_messages where type = 'inventory.stock_changed' and key = $1",
      [variant],
    );
    expect(Number(effects.rows[0].count)).toBe(2); // một cho sự kiện gốc, một cho sự kiện mốc
  }, 90_000);

  it('handler lỗi: thử lại, sang DLQ, tác động rollback, sự kiện sau cùng partition vẫn chạy; script đẩy lại xử lý được (AC-4, AC-5, AC-9)', async () => {
    let fixed = false;
    const calls: string[] = [];
    const done: string[] = [];
    const runner = src.consumer.createConsumerRunner(options(), {
      consumer: 'dlq',
      scope: 'shared',
      handlers: new Map([
        [
          'inventory.below_threshold',
          async (event) => {
            const payload = event.payload as { variantId: string; minQty: number };
            calls.push(event.eventId);
            if (payload.minQty === 999 && !fixed) {
              await src.platform.publishEvent({
                type: 'inventory.stock_changed',
                aggregateId: payload.variantId,
                payload: { variantId: payload.variantId, onHand: 9, reserved: 0, available: 9 },
              });
              throw new Error('lỗi thử');
            }
            done.push(event.eventId);
          },
        ],
      ]),
    });
    stops.push(() => runner.stop());
    await runner.start();

    const company = randomUUID();
    const variant = randomUUID();
    const bad = await publishBelow(company, variant, 999);
    const good = await publishBelow(company, variant, 1);
    await relayAll(relay);
    await waitFor(() => done.includes(good));
    expect(calls.filter((id) => id === bad)).toHaveLength(4);

    const dlq = await readTopic(`${prefix}.inventory.dlq`, (m) => m.some((x) => x.headers.eventId === bad));
    const dead = dlq.find((m) => m.headers.eventId === bad)!;
    expect(dead.key).toBe(variant);
    expect(dead.headers).toMatchObject({
      'x-attempts': '4',
      'x-consumer': 'dlq',
      'x-original-topic': `${prefix}.inventory`,
    });
    expect(dead.headers['x-error']).toContain('lỗi thử');
    // Tác động của handler lỗi (onHand 9) đã rollback; consumer `e2e` của test trước cũng nghe loại này và ghi onHand 0.
    const effects = await testPool().query(
      `select count(*) from core.outbox_messages
       where type = 'inventory.stock_changed' and key = $1 and payload->>'onHand' = '9'`,
      [variant],
    );
    expect(Number(effects.rows[0].count)).toBe(0);

    fixed = true;
    expect(await src.replay.replayDlq(options(), `${prefix}.inventory.dlq`)).toBeGreaterThanOrEqual(1);
    await waitFor(() => done.includes(bad));
    expect(done.filter((id) => id === good)).toHaveLength(1);
    expect(await src.replay.replayDlq(options(), `${prefix}.inventory.dlq`)).toBe(0);
  }, 120_000);

  it('hai bản sao cùng tên chia partition, mỗi sự kiện một bản xử lý (AC-7)', async () => {
    const handled: [number, string][] = [];
    const runners = [0, 1].map((n) =>
      src.consumer.createConsumerRunner(options(), {
        consumer: 'split',
        scope: 'shared',
        handlers: new Map([['sales.order_created', async (event) => void handled.push([n, event.eventId])]]),
      }),
    );
    for (const r of runners) {
      stops.push(() => r.stop());
      await r.start();
    }
    await waitFor(() => runners.every((r) => r.assignment().length > 0), 60_000);

    const company = randomUUID();
    const orders = Array.from({ length: 20 }, () => randomUUID());
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) {
      const orderId = orders[i % 20]!;
      ids.push(
        await src.db.withCompany(company, () =>
          src.platform.publishEvent({
            type: 'sales.order_created',
            aggregateId: orderId,
            payload: { orderId, code: `DH${i}`, source: 'manual', total: '1.00' },
          }),
        ),
      );
    }
    await relayAll(relay);
    await waitFor(() => new Set(handled.map(([, id]) => id)).size === 60);
    expect(handled).toHaveLength(60);
    expect(new Set(handled.map(([n]) => n))).toEqual(new Set([0, 1]));
  }, 120_000);
});

describe('đăng ký qua platform/index.ts (AC-6)', () => {
  it('registerConsumer + startBackground của platform: relay và handler chạy, hàm dừng ngắt được', async () => {
    const got: string[] = [];
    src.platform.registerConsumer('purchasing.order_submitted', async (event) => void got.push(event.eventId), {
      consumer: 'qua-index',
    });
    const stop = await src.platform.platformModule.startBackground!({} as ModuleContext);
    try {
      const purchaseOrderId = randomUUID();
      const id = await src.db.withCompany(randomUUID(), () =>
        src.platform.publishEvent({
          type: 'purchasing.order_submitted',
          aggregateId: purchaseOrderId,
          payload: { purchaseOrderId, code: 'DM1' },
        }),
      );
      await waitFor(() => got.includes(id), 60_000);
    } finally {
      await stop();
    }
  }, 120_000);
});

describe('consumer instance', () => {
  it('hai bản sao realtime đều nhận mọi sự kiện (AC-7)', async () => {
    const got: [number, string][] = [];
    const runners = [0, 1].map((n) =>
      src.consumer.createConsumerRunner(options(), {
        consumer: 'rt',
        scope: 'instance',
        handlers: new Map([['payment.succeeded', async (event) => void got.push([n, event.eventId])]]),
      }),
    );
    for (const r of runners) {
      stops.push(() => r.stop());
      await r.start();
    }
    await waitFor(() => runners.every((r) => r.assignment().length === 3), 60_000);

    const company = randomUUID();
    const publishPayment = () => {
      const orderId = randomUUID();
      return src.db.withCompany(company, () =>
        src.platform.publishEvent({
          type: 'payment.succeeded',
          aggregateId: orderId,
          payload: { orderId, paymentTransactionId: randomUUID(), gateway: 'vnpay', amount: '10.00' },
        }),
      );
    };
    // Instance đọc từ mới nhất: phát mốc tới khi cả hai bản sao nhận được, rồi mới phát sự kiện thật.
    const markers = new Set<string>();
    await waitFor(async () => {
      markers.add(await publishPayment());
      await relayAll(relay);
      await sleep(300);
      return [0, 1].every((n) => got.some(([r, id]) => r === n && markers.has(id)));
    }, 60_000);

    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(await publishPayment());
    await relayAll(relay);
    const received = (n: number) => got.filter(([r, id]) => r === n && ids.includes(id)).map(([, id]) => id).sort();
    await waitFor(() => received(0).length === 10 && received(1).length === 10);
    for (const n of [0, 1]) expect(received(n)).toEqual([...ids].sort());
  }, 120_000);
});

describe('Kafka dừng (AC-3)', () => {
  it('ghi sự kiện vẫn thành công, relay không đánh dấu; Kafka chạy lại thì gửi hết', async () => {
    const shortRelay = src.relay.createRelay(options({ messageTimeoutMs: 5_000 }));
    stops.push(() => shortRelay.stop());
    await relayAll(shortRelay); // nối producer khi Kafka còn chạy

    await kafka.pause();
    const variant = randomUUID();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await publishStock(randomUUID(), variant, i));
    await expect(shortRelay.tick()).rejects.toThrow();
    expect(await unpublished(ids)).toBe(5);

    await kafka.unpause();
    await waitFor(async () => {
      await shortRelay.tick().catch(() => undefined);
      return (await unpublished(ids)) === 0;
    }, 90_000);
    const messages = await readTopic(`${prefix}.inventory`, (m) => ids.every((id) => m.some((x) => x.headers.eventId === id)));
    for (const id of ids) expect(messages.filter((m) => m.headers.eventId === id).length).toBeGreaterThanOrEqual(1);
  }, 180_000);
});
