// #198 phần 2: sự kiện `inventory.stocktake_posted` sai thì vào DLQ của group `channel-opening-stocktake`, không đặt mốc
// sai (review S1). Chạy `processMessage` thật, không Kafka, không DB: handler ném trước khi chạm DB.
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { onOpeningStocktakePosted } from '#src/modules/channel/channel/service/opening-stocktake.ts';
import {
  type Handler,
  HandlerFailure,
  type IncomingMessage,
  processMessage,
  type ProcessDeps,
} from '#src/modules/core/platform/service/outbox/consumer.ts';

const TYPE = 'inventory.stocktake_posted';
const RETRIES = [1_000, 5_000, 30_000];

function message(payload: Record<string, unknown>): IncomingMessage {
  const envelope = {
    eventId: randomUUID(),
    type: TYPE,
    companyId: randomUUID(),
    aggregateId: randomUUID(),
    occurredAt: new Date().toISOString(),
    payload,
  };
  return { topic: 'commerio.inventory', partition: 0, offset: '1', key: null, headers: { type: TYPE }, value: Buffer.from(JSON.stringify(envelope)) };
}

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    documentId: randomUUID(),
    number: 'KK-000001',
    source: { type: 'shop_setup', shopId: randomUUID() },
    postedAt: now,
    countedAt: now,
    lines: [],
    ...over,
  };
}

function deps() {
  const handler: Handler = (e) => onOpeningStocktakePosted(e.payload as Parameters<typeof onOpeningStocktakePosted>[0]);
  return {
    spec: { consumer: 'channel-opening-stocktake', scope: 'shared' as const, handlers: new Map([[TYPE, handler]]) },
    retryDelaysMs: RETRIES,
    // Như `runShared`: lỗi của handler bọc `HandlerFailure`.
    runHandler: vi.fn<ProcessDeps['runHandler']>(async (envelope, h) => {
      try {
        await h(envelope);
      } catch (err) {
        throw new HandlerFailure(err);
      }
    }),
    sendToDlq: vi.fn<ProcessDeps['sendToDlq']>(async () => undefined),
  };
}

describe('consumer channel-opening-stocktake: sự kiện sai vào DLQ', () => {
  it('thiếu countedAt: DLQ ngay, không chạy handler', async () => {
    const d = deps();
    const { countedAt, ...rest } = payload();
    expect(countedAt).toBeDefined();
    expect(await processMessage(message(rest), 0, d)).toEqual({ kind: 'done' });
    expect(d.runHandler).not.toHaveBeenCalled();
    expect(d.sendToDlq).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/payload sai/), 0);
  });

  it.each([
    ['countedAt sau postedAt', { countedAt: '2026-11-09T10:00:00.000Z', postedAt: '2026-11-09T09:00:00.000Z' }, /sau postedAt/],
    ['countedAt ở tương lai', { countedAt: '2999-01-01T00:00:00.000Z', postedAt: '2999-01-01T00:00:00.000Z' }, /tương lai/],
  ])('%s: thử lại theo lịch rồi DLQ', async (_name, over, reason) => {
    const d = deps();
    const msg = message(payload(over));
    for (const [attempt, delayMs] of RETRIES.entries()) expect(await processMessage(msg, attempt, d)).toEqual({ kind: 'retry', delayMs });
    expect(await processMessage(msg, RETRIES.length, d)).toEqual({ kind: 'done' });
    expect(d.sendToDlq).toHaveBeenCalledTimes(1);
    expect(d.sendToDlq).toHaveBeenCalledWith(msg, expect.stringMatching(reason), RETRIES.length + 1);
  });
});
