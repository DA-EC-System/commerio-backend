import { randomUUID } from 'node:crypto';
import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import {
  type ConsumerScope,
  HandlerFailure,
  type IncomingMessage,
  isConnectionError,
  processMessage,
  type ProcessDeps,
} from '#src/modules/core/platform/service/outbox/consumer.ts';

// Quyết định cho một message của consumer (#38 AC-5, AC-9, S2, S8): không Kafka, không DB.
const TYPE = 'inventory.below_threshold';
const variantId = randomUUID();
const envelope = (over: Record<string, unknown> = {}) => ({
  eventId: randomUUID(),
  type: TYPE,
  companyId: randomUUID(),
  aggregateId: variantId,
  occurredAt: new Date().toISOString(),
  payload: { variantId, available: 1, minQty: 5 },
  ...over,
});
const message = (value: unknown, type = TYPE): IncomingMessage => ({
  topic: 'commerio.inventory',
  partition: 1,
  offset: '7',
  key: Buffer.from(variantId),
  headers: { type },
  value: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
});

function deps(scope: ConsumerScope, runHandler: ProcessDeps['runHandler'] = async () => undefined) {
  return {
    spec: { consumer: 'thu', scope, handlers: new Map([[TYPE, async () => undefined]]) },
    retryDelaysMs: [1_000, 5_000, 30_000],
    runHandler: vi.fn(runHandler),
    sendToDlq: vi.fn<ProcessDeps['sendToDlq']>(async () => undefined),
  };
}
const failing = (err: unknown) => async () => {
  throw new HandlerFailure(err);
};

describe('processMessage', () => {
  it('bỏ qua loại không đăng ký mà không kiểm schema, không DLQ', async () => {
    const d = deps('shared');
    expect(await processMessage(message('rác', 'sales.order_created'), 0, d)).toEqual({ kind: 'done' });
    expect(d.sendToDlq).not.toHaveBeenCalled();
    expect(d.runHandler).not.toHaveBeenCalled();
  });

  it('chạy handler với envelope đã kiểm schema', async () => {
    const d = deps('shared');
    const e = envelope();
    expect(await processMessage(message(e), 0, d)).toEqual({ kind: 'done' });
    expect(d.runHandler).toHaveBeenCalledWith(e, expect.any(Function));
  });

  it('handler nhận sequence của envelope; message cũ không có sequence vẫn chạy, không sang DLQ', async () => {
    const d = deps('shared');
    const withSeq = envelope({ sequence: 42 });
    const withoutSeq = envelope();
    expect(await processMessage(message(withSeq), 0, d)).toEqual({ kind: 'done' });
    expect(await processMessage(message(withoutSeq), 0, d)).toEqual({ kind: 'done' });
    expect(d.runHandler).toHaveBeenNthCalledWith(1, withSeq, expect.any(Function));
    expect(d.runHandler).toHaveBeenNthCalledWith(2, withoutSeq, expect.any(Function));
    expect(d.sendToDlq).not.toHaveBeenCalled();
  });

  it.each([
    ['value không phải JSON', 'không phải json', /JSON/],
    ['payload sai schema', envelope({ payload: { variantId: 'x' } }), /payload sai/],
    ['header type khác envelope', envelope({ type: 'sales.order_created' }), /khác envelope/],
    ['companyId trống', envelope({ companyId: null }), /companyId trống/],
  ])('%s: sang DLQ ngay, không thử lại (S2)', async (_name, value, reason) => {
    const d = deps('shared');
    expect(await processMessage(message(value), 0, d)).toEqual({ kind: 'done' });
    expect(d.sendToDlq).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(reason), 0);
    expect(d.runHandler).not.toHaveBeenCalled();
  });

  it('handler lỗi: thử lại sau 1 s, 5 s, 30 s rồi sang DLQ ở lần thứ 4 (AC-9)', async () => {
    const d = deps('shared', failing(new Error('hết hàng')));
    const m = message(envelope());
    expect(await processMessage(m, 0, d)).toEqual({ kind: 'retry', delayMs: 1_000 });
    expect(await processMessage(m, 1, d)).toEqual({ kind: 'retry', delayMs: 5_000 });
    expect(await processMessage(m, 2, d)).toEqual({ kind: 'retry', delayMs: 30_000 });
    expect(d.sendToDlq).not.toHaveBeenCalled();
    expect(await processMessage(m, 3, d)).toEqual({ kind: 'done' });
    expect(d.sendToDlq).toHaveBeenCalledWith(m, expect.stringContaining('hết hàng'), 4);
  });

  it('lỗi trước khi gọi handler (mở giao dịch, processed_events) thì ném, không DLQ (S8)', async () => {
    const d = deps('shared', async () => {
      throw new Error('relation does not exist');
    });
    await expect(processMessage(message(envelope()), 0, d)).rejects.toThrow('relation does not exist');
    expect(d.sendToDlq).not.toHaveBeenCalled();
  });

  it('handler ném lỗi mất kết nối DB thì ném, không tính lượt thử (S8)', async () => {
    const d = deps('shared', failing(new Error('Failed query', { cause: Object.assign(new Error('terminating connection'), { code: '57P01' }) })));
    await expect(processMessage(message(envelope()), 3, d)).rejects.toBeInstanceOf(HandlerFailure);
    expect(d.sendToDlq).not.toHaveBeenCalled();
  });

  it('gửi DLQ hỏng thì ném để Kafka giao lại', async () => {
    const d = deps('shared', failing(new Error('x')));
    d.sendToDlq.mockRejectedValueOnce(new Error('broker chết'));
    await expect(processMessage(message(envelope()), 3, d)).rejects.toThrow('broker chết');
  });

  it('handler gọi API ngoài lỗi mạng thì thử lại như lỗi handler, không giao lại mãi', async () => {
    const fetchFailed = new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) });
    const d = deps('shared', failing(fetchFailed));
    expect(await processMessage(message(envelope()), 0, d)).toEqual({ kind: 'retry', delayMs: 1_000 });
  });

  it('DLQ ghi lý do không kèm params của câu SQL', async () => {
    const d = deps('shared', failing(new Error('Failed query: insert ...\nparams: 0901234567,bí mật')));
    await processMessage(message(envelope()), 3, d);
    const reason = d.sendToDlq.mock.calls[0]![1];
    expect(reason).toContain('Failed query');
    expect(reason).not.toContain('bí mật');
  });

  it('instance: lỗi mang mã mạng của handler cũng chỉ ghi log', async () => {
    const reset = new DrizzleQueryError('select 1', [], Object.assign(new Error('x'), { code: 'ECONNRESET' }));
    const d = deps('instance', failing(reset));
    expect(await processMessage(message(envelope()), 0, d)).toEqual({ kind: 'done' });
  });

  it('instance: handler lỗi hay sự kiện sai chỉ ghi log, không thử lại, không DLQ', async () => {
    const d = deps('instance', failing(new Error('x')));
    expect(await processMessage(message(envelope()), 0, d)).toEqual({ kind: 'done' });
    expect(await processMessage(message('rác'), 0, d)).toEqual({ kind: 'done' });
    expect(d.sendToDlq).not.toHaveBeenCalled();
  });

  it('instance: sự kiện companyId trống vẫn chạy handler', async () => {
    const d = deps('instance');
    await processMessage(message(envelope({ companyId: null })), 0, d);
    expect(d.runHandler).toHaveBeenCalled();
  });
});

describe('isConnectionError', () => {
  const withCode = (code: string) => Object.assign(new Error('e'), { code });
  it.each([
    ['lớp 08', withCode('08006')],
    ['server cắt kết nối 57P01', withCode('57P01')],
    ['mã nằm ở cause (DrizzleQueryError)', new Error('Failed query', { cause: withCode('57P01') })],
    ['mã mạng dưới truy vấn DB', new DrizzleQueryError('select 1', [], withCode('ECONNRESET'))],
    ['mất kết nối giữa truy vấn, không mã', new Error('Connection terminated unexpectedly')],
  ])('nhận %s', (_name, err) => {
    expect(isConnectionError(err)).toBe(true);
  });

  it.each([
    ['lỗi ràng buộc 23505', withCode('23505')],
    ['lỗi nghiệp vụ', new Error('hết hàng')],
    ['gọi API ngoài lỗi mạng (fetch failed, không qua DB)', new TypeError('fetch failed', { cause: withCode('ECONNREFUSED') })],
    ['không phải Error', 'chuỗi'],
  ])('không nhận %s', (_name, err) => {
    expect(isConnectionError(err)).toBe(false);
  });
});
