import type { RequestHandler } from 'express';
import type { z } from 'zod';
import { AppError } from '../errors/app-error.ts';

type Part = 'body' | 'query' | 'params';
type Schemas = Partial<Record<Part, z.ZodType>>;

export interface ValidationIssue {
  in: Part;
  path: string;
  message: string;
}

/**
 * Kiểm đầu vào bằng Zod trước khi tới controller.
 * Dữ liệu đã kiểm nằm ở `res.locals.validated` (Express 5 không cho ghi đè `req.query`).
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req, res, next) => {
    const issues: ValidationIssue[] = [];
    const validated: Partial<Record<Part, unknown>> = {};

    for (const part of ['body', 'query', 'params'] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part]);
      if (result.success) {
        validated[part] = result.data;
      } else {
        for (const issue of result.error.issues) {
          issues.push({ in: part, path: issue.path.map(String).join('.'), message: issue.message });
        }
      }
    }

    if (issues.length > 0) {
      next(new AppError(400, 'validation-failed', 'Dữ liệu gửi lên không hợp lệ', { errors: issues }));
      return;
    }
    res.locals.validated = validated;
    next();
  };
}
