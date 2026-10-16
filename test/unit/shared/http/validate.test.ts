import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorHandler } from '#src/shared/errors/error-handler.ts';
import { validate } from '#src/shared/http/validate.ts';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post(
    '/items/:id',
    validate({
      params: z.object({ id: z.coerce.number().int() }),
      body: z.object({ name: z.string().min(1) }),
    }),
    (_req, res) => {
      res.json(res.locals.validated);
    },
  );
  app.use(errorHandler);
  return app;
}

describe('validate', () => {
  it('cho qua và đưa dữ liệu đã chuyển kiểu vào res.locals.validated', async () => {
    const res = await request(buildApp()).post('/items/7').send({ name: 'Áo thun' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ params: { id: 7 }, body: { name: 'Áo thun' } });
  });

  it('gom lỗi của mọi phần rồi trả 422 với errors theo ô', async () => {
    const res = await request(buildApp()).post('/items/abc').send({ name: '' });
    expect(res.status).toBe(422);
    expect(res.body.type).toBe('/problems/validation_failed');
    expect(res.body.code).toBe('validation_failed');
    expect(Object.keys(res.body.errors).sort()).toEqual(['id', 'name']);
    expect(typeof res.body.errors.name).toBe('string');
  });

  it('trường lồng nối bằng dấu chấm, cả thân sai kiểu thì khoá là tên phần', async () => {
    const app = express();
    app.use(express.json());
    app.post('/nested', validate({ body: z.object({ ceo: z.object({ email: z.email() }) }) }), (_req, res) => {
      res.end();
    });
    app.post('/whole', validate({ body: z.array(z.string()) }), (_req, res) => {
      res.end();
    });
    app.use(errorHandler);

    const nested = await request(app).post('/nested').send({ ceo: { email: 'khong-phai-email' } });
    expect(Object.keys(nested.body.errors)).toEqual(['ceo.email']);
    const whole = await request(app).post('/whole').send({ a: 1 });
    expect(Object.keys(whole.body.errors)).toEqual(['body']);
  });
});
