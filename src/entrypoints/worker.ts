import { modules } from '../modules/registry.ts';
import { env } from '../shared/config/env.ts';
import { closeDb } from '../shared/db/client.ts';
import { closeServer, onShutdown } from '../shared/lifecycle.ts';
import { logger } from '../shared/logger.ts';
import { startOpsServer } from '../shared/observability/ops-server.ts';
import { createModuleContext } from '../wiring.ts';

// Việc nền của từng module (relay outbox, consumer, tra cứu định kỳ) khai ở `startBackground` của module đó.
const opsServer = startOpsServer(env.WORKER_PORT, () => {
  logger.info({ port: env.WORKER_PORT }, 'worker đã chạy');
});

const ctx = createModuleContext();
const stops: (() => Promise<void>)[] = [];
let stopping = false;
// Module đang khởi động dở; SIGTERM đến lúc đó thì chờ nó xong rồi dừng luôn nó.
let starting: Promise<unknown> = Promise.resolve();

// Đăng ký trước vòng khởi động: SIGTERM đến giữa vòng thì không khởi động module kế tiếp.
onShutdown('worker', async () => {
  stopping = true;
  await starting.catch(() => undefined);
  await Promise.all(stops.map((stop) => stop()));
  await closeServer(opsServer);
  await closeDb();
});

for (const module of modules) {
  if (stopping) break;
  if (!module.startBackground) continue;
  const started = module.startBackground(ctx);
  starting = started;
  stops.push(await started);
}
