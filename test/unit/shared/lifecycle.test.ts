import { afterEach, describe, expect, it, vi } from 'vitest';
import { every } from '#src/shared/lifecycle.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('every: việc nền định kỳ', () => {
  it('chạy ngay, lượt cũ chưa xong thì bỏ nhịp, dừng thì chờ lượt đang chạy', async () => {
    vi.useFakeTimers();
    let finish: () => void = () => {};
    const job = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const stop = every(1000, job, 'lỗi');
    expect(job).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3000);
    expect(job).toHaveBeenCalledTimes(1);

    finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(job).toHaveBeenCalledTimes(2);

    let stopped = false;
    const stopping = stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    finish();
    await stopping;
    await vi.advanceTimersByTimeAsync(5000);
    expect(job).toHaveBeenCalledTimes(2);
  });

  it('lỗi của một lượt không dừng các lượt sau', async () => {
    vi.useFakeTimers();
    const job = vi.fn().mockRejectedValueOnce(new Error('sàn lỗi')).mockResolvedValue(undefined);
    const stop = every(1000, job, 'lỗi');
    await vi.advanceTimersByTimeAsync(1000);
    expect(job).toHaveBeenCalledTimes(2);
    await stop();
  });
});
