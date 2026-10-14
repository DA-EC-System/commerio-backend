import type { Server } from 'node:http';
import express from 'express';
import { metricsEndpoint } from './metrics.ts';

/** Cổng vận hành cho tiến trình không phục vụ API (worker, realtime): probe của Kubernetes và Prometheus. */
export function startOpsServer(port: number, onListening: () => void): Server {
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/metrics', metricsEndpoint);
  return app.listen(port, onListening);
}
