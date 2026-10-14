import { env } from '../shared/config/env.ts';
import { closeServer, onShutdown } from '../shared/lifecycle.ts';
import { logger } from '../shared/logger.ts';
import { startOpsServer } from '../shared/observability/ops-server.ts';

// Chưa có kênh SSE nào. Sau này: nghe Kafka (mỗi bản sao một consumer group) rồi đẩy sự kiện xuống trình duyệt.
const opsServer = startOpsServer(env.REALTIME_PORT, () => {
  logger.info({ port: env.REALTIME_PORT }, 'realtime đã chạy');
});

onShutdown('realtime', async () => {
  await closeServer(opsServer);
});
