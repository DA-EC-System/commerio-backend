import express, { Router } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { metricsMiddleware, metricsRegistry } from '#src/shared/observability/metrics.ts';

/** Nhãn `route` của các lần đo đã ghi, theo thứ tự xuất hiện trong registry. */
async function routeLabels(): Promise<string[]> {
  const text = await metricsRegistry.getSingleMetricAsString('http_request_duration_seconds');
  return [...text.matchAll(/_count\{[^}]*route="([^"]*)"/g)].map((m) => m[1]!);
}

describe('metricsMiddleware', () => {
  it('nhãn route là mẫu route đầy đủ dù phản hồi gửi từ handler hay lỗi đi ra khỏi router', async () => {
    const app = express();
    app.use(metricsMiddleware);
    app.get('/health', (_req, res) => void res.json({ status: 'ok' }));

    const webhooks = Router();
    webhooks.post('/sepay/:receiverKey', (_req, res) => void res.status(200).end());
    webhooks.post('/hong/:id', () => {
      throw new Error('lỗi trong router lồng');
    });
    const payment = Router();
    payment.get('/m1/orders/:orderId', (_req, res) => void res.status(200).end());
    payment.get('/m1/loi/:id', () => {
      throw new Error('lỗi trong route');
    });
    payment.use('/webhooks', webhooks);
    app.use('/api/v1/payment', payment);

    const docs = Router();
    docs.get('/m1-openapi.json', (_req, res) => void res.json({}));
    app.use('/api', docs);
    app.use(((_err, _req, res, _next) => void res.status(500).end()) as express.ErrorRequestHandler);

    await request(app).get('/health');
    await request(app).get('/api/v1/payment/m1/orders/abc');
    await request(app).get('/api/v1/payment/m1/loi/abc');
    await request(app).post('/api/v1/payment/webhooks/sepay/k');
    await request(app).post('/api/v1/payment/webhooks/hong/1');
    await request(app).get('/api/m1-openapi.json');
    await request(app).get('/api/v1/khong-co');

    const labels = await routeLabels();
    expect(labels).toEqual(
      expect.arrayContaining([
        '/health',
        '/api/v1/payment/m1/orders/:orderId',
        '/api/v1/payment/m1/loi/:id',
        '/api/v1/payment/webhooks/sepay/:receiverKey',
        '/api/v1/payment/webhooks/hong/:id',
        '/api/m1-openapi.json',
        'unmatched',
      ]),
    );
    expect(labels).not.toContain('/m1/loi/:id');
    expect(labels).not.toContain('/hong/:id');
  });
});
