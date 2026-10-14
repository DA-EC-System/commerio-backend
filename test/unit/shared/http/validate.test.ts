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

  it('gom lỗi của mọi phần rồi trả 400', async () => {
    const res = await request(buildApp()).post('/items/abc').send({ name: '' });
    expect(res.status).toBe(400);
    expect(res.body.type).toBe('/problems/validation-failed');
    expect(res.body.errors).toHaveLength(2);
    expect(res.body.errors.map((e: { in: string }) => e.in).sort()).toEqual(['body', 'params']);
  });
});
