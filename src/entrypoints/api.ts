import { createApp } from '../app.ts';
import { env } from '../shared/config/env.ts';
import { closeDb } from '../shared/db/client.ts';
import { closeServer, onShutdown } from '../shared/lifecycle.ts';
import { logger } from '../shared/logger.ts';
import { startOpsServer } from '../shared/observability/ops-server.ts';

const server = createApp().listen(env.API_PORT, () => {
  logger.info({ port: env.API_PORT }, 'api đã chạy');
});

const opsServer = startOpsServer(env.API_OPS_PORT, () => {
  logger.info({ port: env.API_OPS_PORT }, 'cổng vận hành của api đã chạy');
});

onShutdown('api', async () => {
  await Promise.all([closeServer(server), closeServer(opsServer)]);
  await closeDb();
});
