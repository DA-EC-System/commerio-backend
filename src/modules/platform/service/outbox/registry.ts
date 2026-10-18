// Sổ đăng ký của registerConsumer. Không import client Kafka: tiến trình api nạp file này qua platform/index.ts,
// còn consumer.ts (có Kafka) chỉ nạp khi một consumer thật sự khởi động.
import { EVENT_SCHEMAS, type EventType } from '../../domain/events.ts';
import type { ConsumerRunner, ConsumerScope, Handler } from './consumer.ts';
import { type OutboxOptions, outboxOptions, retryUntilAborted } from './runtime.ts';

interface Entry {
  scope: ConsumerScope;
  handlers: Map<string, Handler>;
  started: boolean;
}

const registry = new Map<string, Entry>();
const runners: Promise<ConsumerRunner>[] = [];
let background: { options: OutboxOptions; signal: AbortSignal } | undefined;

function launch(name: string, entry: Entry, options: OutboxOptions, signal: AbortSignal): void {
  entry.started = true;
  const runner = import('./consumer.ts').then(({ createConsumerRunner }) =>
    createConsumerRunner(options, { consumer: name, scope: entry.scope, handlers: entry.handlers }),
  );
  runners.push(runner);
  void runner.then((r) => retryUntilAborted(`consumer ${name}`, signal, () => r.start()));
}

export function register(type: EventType, handler: Handler, consumer: string, scope: ConsumerScope): void {
  if (!Object.hasOwn(EVENT_SCHEMAS, type)) throw new Error(`Loại sự kiện ${type} không có trong danh mục`);
  let entry = registry.get(consumer);
  if (entry && entry.scope !== scope) throw new Error(`Consumer ${consumer} đã đăng ký với scope ${entry.scope}`);
  if (entry?.started) throw new Error(`Consumer ${consumer} đã chạy: đăng ký mọi loại của nó trong một khối đồng bộ`);
  if (entry?.handlers.has(type)) throw new Error(`Consumer ${consumer} đã đăng ký ${type}`);
  if (!entry) {
    const created: Entry = (entry = { scope, handlers: new Map(), started: false });
    registry.set(consumer, created);
    // Khởi động ở lượt kế để các loại đăng ký liền sau trong cùng khối gộp vào một group.
    setImmediate(() => {
      if (created.started) return;
      if (scope === 'instance') launch(consumer, created, outboxOptions(), new AbortController().signal);
      else if (background) launch(consumer, created, background.options, background.signal);
    });
  }
  entry.handlers.set(type, handler);
}

/** Worker: chạy mọi consumer `shared` đã và sẽ đăng ký. Trả hàm dừng. */
export function startSharedConsumers(opts: OutboxOptions, signal: AbortSignal): () => Promise<void> {
  background = { options: opts, signal };
  for (const [name, entry] of registry) if (entry.scope === 'shared' && !entry.started) launch(name, entry, opts, signal);
  return async () => {
    await Promise.all(runners.map(async (runner) => (await runner).stop()));
  };
}
