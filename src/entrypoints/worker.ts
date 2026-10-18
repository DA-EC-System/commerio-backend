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
for (const module of modules) {
  if (module.startBackground) stops.push(await module.startBackground(ctx));
}

onShutdown('worker', async () => {
  await Promise.all(stops.map((stop) => stop()));
  await closeServer(opsServer);
  await closeDb();
});
