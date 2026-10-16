import type { RequestHandler } from 'express';
import type { z } from 'zod';
import { AppError } from '../errors/app-error.ts';

type Part = 'body' | 'query' | 'params';
type Schemas = Partial<Record<Part, z.ZodType>>;

/** Lỗi theo ô: khoá là đường dẫn trường nối bằng dấu chấm (`ceo.email`, `lines.0.quantity`), giá trị là câu báo lỗi. */
export type FieldErrors = Record<string, string>;

/**
 * Kiểm đầu vào bằng Zod trước khi tới controller (hợp đồng FE–BE C1, Documents/21).
 * Sai thì trả 422 `validation_failed` kèm `errors`, mỗi trường giữ lỗi đầu tiên.
 * Dữ liệu đã kiểm nằm ở `res.locals.validated` (Express 5 không cho ghi đè `req.query`).
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req, res, next) => {
    const errors: FieldErrors = {};
    const validated: Partial<Record<Part, unknown>> = {};

    for (const part of ['body', 'query', 'params'] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part]);
      if (result.success) {
        validated[part] = result.data;
        continue;
      }
      for (const issue of result.error.issues) {
        const key = issue.path.length > 0 ? issue.path.map(String).join('.') : part;
        errors[key] ??= issue.message;
      }
    }

    if (Object.keys(errors).length > 0) {
      next(new AppError(422, 'validation_failed', 'Dữ liệu gửi lên không hợp lệ', { errors }));
      return;
    }
    res.locals.validated = validated;
    next();
  };
}
