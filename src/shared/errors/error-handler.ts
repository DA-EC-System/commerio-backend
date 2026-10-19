import type { ErrorRequestHandler, RequestHandler, Response } from 'express';
import { pgError } from '../db/pg-error.ts';
import { AppError } from './app-error.ts';

const PROBLEM_TYPE_BASE = '/problems/';

function sendProblem(
  res: Response,
  status: number,
  code: string,
  detail: string,
  instance: string,
  extensions: Record<string, unknown> = {},
): void {
  res
    .status(status)
    .type('application/problem+json')
    .json({ type: PROBLEM_TYPE_BASE + code, title: code, status, detail, instance, code, ...extensions });
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(404, 'not_found', `Không có đường dẫn ${req.method} ${req.originalUrl}`));
};

function isJsonParseError(err: unknown): boolean {
  return err instanceof SyntaxError && (err as { type?: string }).type === 'entity.parse.failed';
}

/** Thân yêu cầu vượt giới hạn của `express.json` (body-parser đặt `type` này, `status` 413). */
function isTooLarge(err: unknown): boolean {
  return (err as { type?: string } | null)?.type === 'entity.too.large';
}

// Xử lý lỗi tập trung: mọi lỗi ném ra (kể cả từ hàm async) đều về đây.
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof AppError) {
    sendProblem(res, err.status, err.code, err.message, req.originalUrl, err.extensions);
    return;
  }
  if (isJsonParseError(err)) {
    sendProblem(res, 400, 'malformed_json', 'Thân yêu cầu không phải JSON hợp lệ', req.originalUrl);
    return;
  }
  if (isTooLarge(err)) {
    sendProblem(res, 413, 'payload_too_large', 'Thân yêu cầu quá lớn', req.originalUrl);
    return;
  }
  // Serializer lỗi của pino bỏ `cause`, nên ghi riêng mã PostgreSQL (nếu có) để gỡ lỗi.
  req.log.error({ err, pgCode: pgError(err).code }, 'Lỗi không lường trước');
  sendProblem(res, 500, 'internal_error', 'Lỗi hệ thống', req.originalUrl);
};
