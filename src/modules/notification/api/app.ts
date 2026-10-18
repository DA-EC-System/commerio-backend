import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import { env } from '../../../shared/config/env.ts';
import { errorHandler, notFoundHandler } from '../../../shared/errors/error-handler.ts';
import { logger } from '../../../shared/logger.ts';
import { metricsEndpoint } from '../../../shared/observability/metrics.ts';
import { notificationRouter, type StreamOptions } from './routes.ts';

/**
 * App của tiến trình realtime, một cổng (`REALTIME_PORT`): stream SSE và `/health`, `/metrics` cho probe, Prometheus.
 * Proxy (Caddy #37, Ingress #36) chỉ đưa `/api/v1/notification/stream` ra ngoài, nên `/metrics` không lộ.
 */
export function createRealtimeApp(options: StreamOptions): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  // errorHandler ghi lỗi lạ qua req.log của pino-http.
  app.use(pinoHttp({ logger }));
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/metrics', metricsEndpoint);
  app.use('/api/v1/notification', notificationRouter(options));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
