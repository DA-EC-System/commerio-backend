// Lớp RateLimit của `Retry(RateLimit(TokenRefresh(adapter)))` (Documents/16 bài toán 3, #215 phần TikTok): giãn lời gọi
// theo khoá (vd gian hàng × đọc/ghi) trong một tiến trình. Không chia giữa các tiến trình (api, worker): sàn vẫn có thể
// trả quá tần suất, adapter tự lùi lại (`backoff`) rồi gọi lại một lần.

export interface RateLimiter {
  /** Chờ tới lượt của `key`, mỗi lượt cách nhau `intervalMs`. */
  acquire(key: string, intervalMs: number): Promise<void>;
  /** Sàn báo quá tần suất: lùi mọi lượt sau của `key` thêm `ms` tính từ bây giờ. */
  backoff(key: string, ms: number): void;
}

const SWEEP_AT = 1000;

export function createRateLimiter(now: () => number = Date.now, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): RateLimiter {
  const next = new Map<string, number>();

  function sweep(t: number) {
    if (next.size < SWEEP_AT) return;
    for (const [k, v] of next) if (v <= t) next.delete(k);
  }

  return {
    async acquire(key, intervalMs) {
      const t = now();
      sweep(t);
      const slot = Math.max(t, next.get(key) ?? 0);
      next.set(key, slot + intervalMs);
      if (slot > t) await sleep(slot - t);
    },
    backoff(key, ms) {
      next.set(key, Math.max(next.get(key) ?? 0, now() + ms));
    },
  };
}
