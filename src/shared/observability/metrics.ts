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
  res.on('finish', () => {
    // Nhãn theo mẫu route (/orders/:id), không theo URL thật, để không nổ số chuỗi số liệu.
    const route = req.route ? `${req.baseUrl}${String(req.route.path)}` : 'unmatched';
    stopTimer({ method: req.method, route, status: res.statusCode });
  });
  next();
};

export const metricsEndpoint: RequestHandler = async (_req, res) => {
  res.type(metricsRegistry.contentType).send(await metricsRegistry.metrics());
};
