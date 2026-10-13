import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import { modules } from './modules/registry.ts';
import { errorHandler, notFoundHandler } from './shared/errors/error-handler.ts';
import { logger } from './shared/logger.ts';
import { metricsEndpoint, metricsMiddleware } from './shared/observability/metrics.ts';

// Ráp ứng dụng HTTP: middleware chung → route module → 404 → xử lý lỗi tập trung.
export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(pinoHttp({ logger }));
  app.use(metricsMiddleware);
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/metrics', metricsEndpoint);

  for (const module of modules) {
    if (module.router) app.use(`/api/v1/${module.name}`, module.router);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
