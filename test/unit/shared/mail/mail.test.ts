import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyMailError, MailError, type MailTransport, sendMail, setMailTransport } from '#src/shared/mail/index.ts';
import { metricsRegistry } from '#src/shared/observability/metrics.ts';

const msg = { to: 'nhan@vien.test', subject: 'Mã xác minh', text: 'Mã của bạn: 123456' };

function fakeTransport(impl: MailTransport['sendMail']): MailTransport & { calls: Parameters<MailTransport['sendMail']>[0][] } {
  const calls: Parameters<MailTransport['sendMail']>[0][] = [];
  return {
    calls,
    sendMail: (options) => {
      calls.push(options);
      return impl(options);
    },
  };
}

async function sentCount(template: string, result: string): Promise<number> {
  const metric = await metricsRegistry.getSingleMetric('mail_send_total')?.get();
  return metric?.values.find((v) => v.labels.template === template && v.labels.result === result)?.value ?? 0;
}

afterEach(() => {
  setMailTransport(null);
  vi.useRealTimers();
});

// Lỗi tạm thì outbox thử lại, lỗi vĩnh viễn thì không (#7 spec 6.8).
describe('classifyMailError', () => {
  it.each([
    [{ code: 'ECONNECTION' }, 'transient'],
    [{ code: 'ETIMEDOUT' }, 'transient'],
    [{ code: 'ESOCKET' }, 'transient'],
    [{ code: 'EDNS' }, 'transient'],
    [{ responseCode: 421 }, 'transient'],
    [{ responseCode: 550 }, 'permanent'],
    [{ code: 'EAUTH', responseCode: 535 }, 'permanent'],
    [{ code: 'EAUTH' }, 'permanent'],
    [new Error('lạ'), 'transient'],
  ])('phân loại lỗi SMTP %o là %s', (err, kind) => expect(classifyMailError(err)).toBe(kind));
});

describe('sendMail', () => {
  it('gửi qua transport đã đặt, from là MAIL_FROM', async () => {
    const fake = fakeTransport(async () => ({}));
    setMailTransport(fake);
    await sendMail(msg, 'test-ok');
    expect(fake.calls).toEqual([{ from: 'Commerio <no-reply@commerio.test>', ...msg }]);
    expect(await sentCount('test-ok', 'ok')).toBe(1);
  });

  it('chưa đặt SMTP_URL và không có transport giả thì ném MailError permanent', async () => {
    setMailTransport(null);
    await expect(sendMail(msg, 'test-missing')).rejects.toMatchObject({ kind: 'permanent' });
    expect(await sentCount('test-missing', 'permanent')).toBe(1);
  });

  it('lỗi tạm của SMTP ra MailError transient', async () => {
    setMailTransport(fakeTransport(async () => Promise.reject(Object.assign(new Error('x'), { code: 'ECONNECTION' }))));
    const err = await sendMail(msg, 'test-transient').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailError);
    expect(err).toMatchObject({ kind: 'transient' });
    expect(await sentCount('test-transient', 'transient')).toBe(1);
  });

  it('MailError không chép phản hồi SMTP vào message', async () => {
    const smtp = Object.assign(new Error('550 5.1.1 nhan@vien.test: không có hộp thư'), {
      responseCode: 550,
      response: '550 5.1.1 nhan@vien.test: không có hộp thư',
    });
    setMailTransport(fakeTransport(async () => Promise.reject(smtp)));
    const err = (await sendMail(msg, 'test-permanent').catch((e: unknown) => e)) as MailError;
    expect(err.kind).toBe('permanent');
    expect(JSON.stringify({ ...err, message: err.message })).not.toContain('nhan@vien.test');
    expect(err.cause).toBeUndefined();
  });

  it('transport treo quá 10 giây thì ra MailError transient', async () => {
    vi.useFakeTimers();
    setMailTransport(fakeTransport(() => new Promise(() => {})));
    const pending = sendMail(msg, 'test-timeout').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ kind: 'transient' });
  });
});
