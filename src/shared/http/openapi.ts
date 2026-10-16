import { OpenAPIRegistry, OpenApiGeneratorV31, type RouteConfig } from '@asteasolutions/zod-to-openapi';
import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { z } from 'zod';

/** Một nhóm đường dẫn cùng tiền tố. Module khai đường dẫn tương đối, viết `:id` như Express. */
export interface OpenApiMount {
  readonly prefix: string;
  /** Nhóm trên Swagger UI khi route không tự ghi `tags`. */
  readonly tag?: string;
  readonly register: (registry: OpenAPIRegistry) => void;
}

export type OpenApiDocument = ReturnType<OpenApiGeneratorV31['generateDocument']>;

/** Thân lỗi mà `errorHandler` trả về (RFC 9457). */
export const ProblemDetailsSchema = z
  .object({
    type: z.string().meta({ example: '/problems/validation_failed' }),
    title: z.string().meta({ example: 'validation_failed' }),
    status: z.number().int().meta({ example: 422 }),
    detail: z.string().meta({ example: 'Dữ liệu gửi lên không hợp lệ' }),
    instance: z.string().meta({ example: '/api/v1/catalog/products' }),
    code: z.string().meta({ example: 'validation_failed', description: 'Mã lỗi cho máy đọc, viết gạch dưới' }),
    errors: z
      .record(z.string(), z.string())
      .optional()
      .meta({ example: { 'ceo.email': 'Email không hợp lệ' }, description: 'Lỗi theo ô, chỉ có ở 422' }),
  })
  .catchall(z.unknown())
  .meta({ id: 'ProblemDetails', description: 'Lỗi theo RFC 9457 kèm `code`. Lỗi kiểm dữ liệu (422) có thêm `errors` theo ô.' });

/** Dùng trong `responses` của route: `{ 404: problemResponse('Không tìm thấy sản phẩm') }`. */
export function problemResponse(description: string) {
  return { description, content: { 'application/problem+json': { schema: ProblemDetailsSchema } } };
}

function toOpenApiPath(prefix: string, path: string): string {
  const full = `${prefix}${path === '/' ? '' : path}` || '/';
  return full.replace(/:(\w+)/g, '{$1}');
}

/** Gom đường dẫn của mọi nhóm thành một tài liệu OpenAPI 3.1. Schema Zod sai thì ném lỗi ngay lúc khởi động. */
export function buildOpenApiDocument(mounts: readonly OpenApiMount[]): OpenApiDocument {
  const definitions = mounts.flatMap(({ prefix, tag, register }) => {
    const registry = new OpenAPIRegistry();
    register(registry);
    return registry.definitions.map((definition) => {
      if (definition.type !== 'route') return definition;
      const route: RouteConfig = {
        ...definition.route,
        path: toOpenApiPath(prefix, definition.route.path),
        tags: definition.route.tags ?? (tag ? [tag] : undefined),
      };
      return { ...definition, route };
    });
  });

  return new OpenApiGeneratorV31(definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Commerio API',
      version: '1',
      description: 'REST API của Commerio. Lỗi trả về dạng Problem Details (RFC 9457).',
    },
  });
}

/** `GET /openapi.json` trả tài liệu, `/docs` là Swagger UI. */
export function openApiRouter(document: OpenApiDocument): Router {
  const router = Router();
  router.get('/openapi.json', (_req, res) => {
    res.json(document);
  });
  router.use('/docs', swaggerUi.serve, swaggerUi.setup(document, { customSiteTitle: 'Commerio API' }));
  return router;
}
