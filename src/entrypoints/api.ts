import { createApp } from '../app.ts';
import { env } from '../shared/config/env.ts';
import { closeDb } from '../shared/db/client.ts';
import { closeServer, onShutdown } from '../shared/lifecycle.ts';
import { logger } from '../shared/logger.ts';

const server = createApp().listen(env.API_PORT, () => {
  logger.info({ port: env.API_PORT }, 'api đã chạy');
});

onShutdown('api', async () => {
  await closeServer(server);
  await closeDb();
});
