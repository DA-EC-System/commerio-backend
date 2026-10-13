import { env } from '../shared/config/env.ts';
import { closeDb } from '../shared/db/client.ts';
import { closeServer, onShutdown } from '../shared/lifecycle.ts';
import { logger } from '../shared/logger.ts';
import { startOpsServer } from '../shared/observability/ops-server.ts';

// Chưa có consumer nào. Sau này: đọc outbox đẩy lên Kafka, nghe sự kiện để đẩy tồn lên sàn, gửi email, dựng số liệu.
const opsServer = startOpsServer(env.WORKER_PORT, () => {
  logger.info({ port: env.WORKER_PORT }, 'worker đã chạy');
});

onShutdown('worker', async () => {
  await closeServer(opsServer);
  await closeDb();
});
