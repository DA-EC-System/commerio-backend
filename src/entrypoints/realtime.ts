import { createHub, createRealtimeApp, startNotifications } from '../modules/notification/index.ts';
import { stopInstanceConsumers } from '../modules/platform/index.ts';
import { env } from '../shared/config/env.ts';
import { closeDb } from '../shared/db/client.ts';
import { closeServer, onShutdown } from '../shared/lifecycle.ts';
import { logger } from '../shared/logger.ts';
import { startOpsServer } from '../shared/observability/ops-server.ts';

// Kênh SSE thông báo (#33): nghe Kafka bằng consumer `instance` (mỗi bản sao một group) rồi đẩy xuống trình duyệt.
// /health, /metrics ở cổng vận hành riêng (REALTIME_OPS_PORT); proxy chỉ đưa cổng stream ra ngoài.
const hub = createHub();
startNotifications(hub);

const server = createRealtimeApp({ hub }).listen(env.REALTIME_PORT, () => {
  logger.info({ port: env.REALTIME_PORT }, 'realtime đã chạy');
});
const opsServer = startOpsServer(env.REALTIME_OPS_PORT, () => {
  logger.info({ port: env.REALTIME_OPS_PORT }, 'cổng vận hành realtime đã chạy');
});

onShutdown('realtime', async () => {
  // server.close() chờ mọi stream đang mở, nên đóng stream trước; rồi ngắt consumer Kafka, cuối cùng là DB.
  hub.closeAll();
  await closeServer(server);
  await stopInstanceConsumers();
  await closeServer(opsServer);
  await closeDb();
});
