import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import { z } from 'zod';
import { modules } from './modules/registry.ts';
import { env } from './shared/config/env.ts';
import { errorHandler, notFoundHandler } from './shared/errors/error-handler.ts';
import { buildOpenApiDocument, openApiRouter, type OpenApiMount } from './shared/http/openapi.ts';
import { logger } from './shared/logger.ts';
import type { ModuleContext } from './shared/module.ts';
import { metricsMiddleware } from './shared/observability/metrics.ts';
import { createModuleContext } from './wiring.ts';

const healthMount: OpenApiMount = {
  prefix: '',
  tag: 'system',
  register: (registry) => {
    registry.registerPath({
      method: 'get',
      path: '/health',
      summary: 'Kiểm tra api còn chạy',
      responses: {
        200: {
          description: 'Đang chạy',
          content: { 'application/json': { schema: z.object({ status: z.literal('ok') }) } },
        },
      },
    });
  },
};

// Ráp ứng dụng HTTP: middleware chung → route module → 404 → xử lý lỗi tập trung.
// /metrics không nằm ở đây mà ở cổng vận hành riêng (OPS_PORT), không đưa ra Ingress.
export function createApp(ctx: ModuleContext = createModuleContext()): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY_HOPS);

  app.use(pinoHttp({ logger }));
  app.use(metricsMiddleware);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  for (const module of modules) {
    if (module.router) app.use(`/api/v1/${module.name}`, module.router(ctx));
  }

  // Swagger UI ở /api/docs, tài liệu ở /api/openapi.json. Sinh từ schema Zod của từng module.
  if (env.API_DOCS_ENABLED) {
    const mounts = modules.flatMap((m) =>
      m.openapi ? [{ prefix: `/api/v1/${m.name}`, tag: m.name, register: m.openapi }] : [],
    );
    app.use('/api', openApiRouter(buildOpenApiDocument([healthMount, ...mounts])));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
