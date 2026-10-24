import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';
import { createRealtimeApp } from '#src/modules/core/notification/index.ts';

/** App realtime thật trên cổng trống; trả server và URL của stream. */
export async function startRealtime(options: Parameters<typeof createRealtimeApp>[0]): Promise<{ server: Server; url: string }> {
  const server = createRealtimeApp(options).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/notification/stream` };
}

export interface Stream {
  readonly status: number;
  readonly headers: Headers;
  /** Toàn bộ chữ đã nhận. */
  text(): string;
  /** Chờ tới khi chữ đã nhận thoả `check`. */
  until(check: (text: string) => boolean, timeout?: number): Promise<string>;
  /** Chờ server kết thúc stream; `false` nếu hết `timeout` mà chưa kết thúc. */
  ended(timeout?: number): Promise<boolean>;
  abort(): void;
}

/** Mở stream bằng `fetch` (Supertest đệm cả response nên không đọc được SSE) và đọc dần thành chữ. */
export async function openStream(url: string, token?: string): Promise<Stream> {
  const controller = new AbortController();
  const res = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: controller.signal });
  let text = '';
  let done = false;
  const reading = (async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of res.body!) text += decoder.decode(chunk, { stream: true });
    } catch {
      // abort từ phía test
    }
    done = true;
  })();
  return {
    status: res.status,
    headers: res.headers,
    text: () => text,
    until: async (check, timeout = 5_000) => {
      await vi.waitUntil(() => check(text), { timeout, interval: 20 });
      return text;
    },
    ended: async (timeout = 5_000) => {
      await Promise.race([reading, new Promise((r) => setTimeout(r, timeout))]);
      return done;
    },
    abort: () => controller.abort(),
  };
}
