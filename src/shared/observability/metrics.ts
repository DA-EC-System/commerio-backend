import type { RequestHandler } from 'express';
import client from 'prom-client';

export const metricsRegistry = new client.Registry();
client.collectDefaultMetrics({ register: metricsRegistry });

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Thời gian xử lý yêu cầu HTTP',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [metricsRegistry],
});

export const metricsMiddleware: RequestHandler = (req, res, next) => {
  const stopTimer = httpRequestDuration.startTimer();
  // Nhãn theo mẫu route (/orders/:id), không theo URL thật, để không nổ số chuỗi số liệu. Chụp lúc Express gán
  // `req.route` (khi đó `req.baseUrl` còn đủ tiền tố của mọi router lồng): lúc `finish`, lỗi đã đi ra khỏi
  // router nên `baseUrl` bị trả về rỗng. Lỗi ném trước khi khớp route (vd 413 của express.json) là `unmatched`.
  let route = 'unmatched';
  let matched: unknown;
  Object.defineProperty(req, 'route', {
    configurable: true,
    enumerable: true,
    get: () => matched,
    set(value: { path?: unknown } | undefined) {
      matched = value;
      if (value) route = `${req.baseUrl}${String(value.path)}`;
    },
  });
  res.on('finish', () => {
    stopTimer({ method: req.method, route, status: res.statusCode });
  });
  next();
};

export const metricsEndpoint: RequestHandler = async (_req, res) => {
  res.type(metricsRegistry.contentType).send(await metricsRegistry.metrics());
};
