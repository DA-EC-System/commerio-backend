import { setImmediate as nextTurn } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';

// Consumer giả: không Kafka. Đếm số runner tạo ra, số lần start và stop.
const runners: { scope: string; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = [];
vi.mock('#src/modules/core/platform/service/outbox/consumer.ts', () => ({
  createConsumerRunner: (_options: unknown, spec: { scope: string }) => {
    const runner = { scope: spec.scope, start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
    runners.push(runner);
    return runner;
  },
}));

const { register, stopInstanceConsumers } = await import('#src/modules/core/platform/service/outbox/registry.ts');

describe('stopInstanceConsumers', () => {
  it('dừng consumer instance đang chạy, consumer instance đăng ký sau đó không khởi động nữa', async () => {
    register('payment.succeeded', async () => undefined, 'chuong-1', 'instance');
    await nextTurn();
    await vi.waitFor(() => expect(runners).toHaveLength(1));
    await vi.waitFor(() => expect(runners[0]!.start).toHaveBeenCalledTimes(1));

    await stopInstanceConsumers();

    expect(runners[0]!.stop).toHaveBeenCalledTimes(1);
    register('payment.succeeded', async () => undefined, 'chuong-2', 'instance');
    await nextTurn();
    await nextTurn();
    expect(runners).toHaveLength(1);
  });
});
