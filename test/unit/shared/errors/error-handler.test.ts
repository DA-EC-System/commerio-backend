import { DrizzleQueryError } from 'drizzle-orm';
import express from 'express';
import { pinoHttp } from 'pino-http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { errorHandler } from '#src/shared/errors/error-handler.ts';
import { createLogger } from '#src/shared/logger.ts';

describe('errorHandler', () => {
  it('lỗi truy vấn không lường trước: trả 500, log kèm mã PostgreSQL nhưng không kèm tham số', async () => {
    const lines: string[] = [];
    const log = createLogger({ write: (line: string) => void lines.push(line) });
    log.level = 'info';
    const app = express();
    app.use(pinoHttp({ logger: log }));
    app.get('/loi', (_req, _res, next) =>
      next(
        new DrizzleQueryError(
          'update finance.gateway_configs set credentials = $1',
          ['KHOA-BIMAT'],
          Object.assign(new Error('could not serialize access'), { code: '40001' }),
        ),
      ),
    );
    app.use(errorHandler);

    const res = await request(app).get('/loi');

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('internal_error');
    const record = lines.map((l) => JSON.parse(l) as { msg: string; pgCode?: string }).find((r) => r.msg === 'Lỗi không lường trước');
    expect(record?.pgCode).toBe('40001');
    expect(lines.join('\n')).not.toContain('KHOA-BIMAT');
  });
});
