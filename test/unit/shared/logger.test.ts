import { DrizzleQueryError } from 'drizzle-orm';
import express from 'express';
import { pinoHttp } from 'pino-http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createLogger } from '#src/shared/logger.ts';

function capture() {
  const lines: string[] = [];
  const log = createLogger({ write: (line: string) => void lines.push(line) });
  log.level = 'info';
  return { log, lines };
}

/** Lỗi như Drizzle ném khi truy vấn hỏng: message và stack mang nguyên tham số. */
const queryError = (params: unknown[]) =>
  new DrizzleQueryError(
    'insert into core.accounts (email, password_hash) values ($1, $2)',
    params,
    Object.assign(new Error('duplicate key value violates unique constraint "accounts_email_unique"'), {
      code: '23505',
      constraint: 'accounts_email_unique',
      detail: 'Key (email)=(CHITIET-BIMAT) already exists.',
    }),
  );

describe('logger', () => {
  it('ẩn header Authorization, Cookie, Set-Cookie', () => {
    const { log, lines } = capture();

    log.info({
      req: { headers: { authorization: 'Bearer bimat', cookie: 'sid=bimat' } },
      res: { headers: { 'set-cookie': 'sid=bimat' } },
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('bimat');
    expect(lines[0]).toContain('[ẩn]');
  });

  it('log truy cập không ghi query string và khoá trong đường dẫn webhook SePay', async () => {
    const { log, lines } = capture();
    const app = express();
    app.use(pinoHttp({ logger: log }));
    app.post('/api/v1/payment/webhooks/sepay/:receiverKey', (req, res) => {
      req.log.info('trong handler');
      res.status(200).end();
    });
    app.get('/api/v1/payment/webhooks/vnpay', (_req, res) => void res.status(200).end());

    // Express khớp route không phân biệt hoa thường, nên che cả `/SEPAY/`.
    await request(app).post('/api/v1/payment/webhooks/SEPAY/KHOA-BIMAT?x=1');
    await request(app).get('/api/v1/payment/webhooks/vnpay?vnp_Amount=1000&vnp_SecureHash=CHUKY-BIMAT');

    const records = lines.map((l) => JSON.parse(l) as { msg: string; req?: { url?: string; query?: unknown } });
    expect(records.map((r) => r.req?.url)).toEqual([
      '/api/v1/payment/webhooks/SEPAY/[ẩn]',
      '/api/v1/payment/webhooks/SEPAY/[ẩn]',
      '/api/v1/payment/webhooks/vnpay',
    ]);
    expect(records.every((r) => r.req !== undefined && !('query' in r.req))).toBe(true);
    expect(lines.join('\n')).not.toMatch(/BIMAT/);
  });

  it('lỗi truy vấn không mang tham số SQL, kể cả tham số nhiều dòng, qua req.log lẫn logger gốc', async () => {
    const { log, lines } = capture();
    const app = express();
    app.use(pinoHttp({ logger: log }));
    app.get('/loi', (_req, _res, next) => next(queryError(['THAMSO-BIMAT', 'dong 1\nTHAMSO-BIMAT-2'])));
    app.use(((err, req, res, _next) => {
      req.log.error({ err }, 'Lỗi không lường trước');
      res.status(500).end();
    }) as express.ErrorRequestHandler);

    await request(app).get('/loi');
    log.error({ err: queryError(['GOC-BIMAT']) }, 'goc');
    log.error(queryError(['TRUCTIEP-BIMAT\nX']), 'truc tiep');
    // Lỗi bọc lỗi truy vấn: stack mang hai đoạn `params:` (của lỗi ngoài và lỗi trong `cause`).
    const inner = queryError(['LONG-BIMAT']);
    const outer = new Error(inner.message, { cause: inner });
    log.error({ err: outer }, 'long');
    // Lỗi pg trần (không qua Drizzle) mang `detail` chép giá trị dòng vi phạm.
    log.error({ err: Object.assign(new Error('duplicate key'), { code: '23505', detail: 'Key (email)=(DETAIL-BIMAT)' }) }, 'tran');

    const all = lines.join('\n');
    expect(all).not.toMatch(/BIMAT/);
    const errors = lines
      .map((l) => JSON.parse(l) as { err?: { type: string; message: string; stack: string; params?: unknown } })
      // pino-http tự ghi thêm một lỗi "failed with status code 500" cho phản hồi 500; chỉ xét lỗi truy vấn.
      .flatMap((r) => (r.err?.type === 'DrizzleQueryError' ? [r.err] : []));
    expect(errors).toHaveLength(3);
    for (const err of errors) {
      expect(err.message).toBe('Failed query: insert into core.accounts (email, password_hash) values ($1, $2)');
      expect(err.stack).toContain('Failed query: insert into core.accounts');
      expect(err.stack).toMatch(/\n {4}at /);
      expect(err).not.toHaveProperty('params');
    }
  });
});
