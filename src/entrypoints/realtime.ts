import { createHub, createRealtimeApp, startNotifications } from '../modules/notification/index.ts';
import { env } from '../shared/config/env.ts';
import { closeDb } from '../shared/db/client.ts';
import { closeServer, onShutdown } from '../shared/lifecycle.ts';
import { logger } from '../shared/logger.ts';

// Kênh SSE thông báo (#33): nghe Kafka bằng consumer `instance` (mỗi bản sao một group) rồi đẩy xuống trình duyệt.
// Cùng cổng có /health, /metrics; proxy chỉ đưa /api/v1/notification/stream ra ngoài.
const hub = createHub();
startNotifications(hub);

const server = createRealtimeApp({ hub }).listen(env.REALTIME_PORT, () => {
  logger.info({ port: env.REALTIME_PORT }, 'realtime đã chạy');
});

onShutdown('realtime', async () => {
  // server.close() chờ mọi stream đang mở, nên đóng stream trước. Consumer Kafka dừng theo tiến trình
  // (platform chưa export hàm dừng consumer instance).
  hub.closeAll();
  await closeServer(server);
  await closeDb();
});
