import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import { env } from '../../../../shared/config/env.ts';
import { errorHandler, notFoundHandler } from '../../../../shared/errors/error-handler.ts';
import { logger } from '../../../../shared/logger.ts';
import { notificationRouter, type StreamOptions } from './routes.ts';

/**
 * App cổng stream của tiến trình realtime (`REALTIME_PORT`): chỉ kênh SSE. `/health`, `/metrics` ở cổng vận hành riêng
 * (`REALTIME_OPS_PORT`, `src/entrypoints/realtime.ts`), như api và worker.
 */
export function createRealtimeApp(options: StreamOptions): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  // errorHandler ghi lỗi lạ qua req.log của pino-http.
  app.use(pinoHttp({ logger }));
  app.use('/api/v1/notification', notificationRouter(options));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
