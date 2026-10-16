import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildOpenApiDocument, problemResponse } from '#src/shared/http/openapi.ts';

const ProductSchema = z.object({ id: z.uuid(), name: z.string() }).meta({ id: 'Product' });

const document = buildOpenApiDocument([
  {
    prefix: '/api/v1/catalog',
    tag: 'catalog',
    register: (registry) => {
      registry.registerPath({
        method: 'get',
        path: '/products/:productId',
        request: { params: z.object({ productId: z.uuid() }) },
        responses: {
          200: { description: 'Sản phẩm', content: { 'application/json': { schema: ProductSchema } } },
          404: problemResponse('Không tìm thấy sản phẩm'),
        },
      });
      registry.registerPath({ method: 'get', path: '/', tags: ['khac'], responses: { 204: { description: 'Rỗng' } } });
    },
  },
]);

describe('buildOpenApiDocument', () => {
  it('ghép tiền tố module và đổi :param của Express thành {param}', () => {
    expect(Object.keys(document.paths ?? {})).toEqual(['/api/v1/catalog/products/{productId}', '/api/v1/catalog']);
  });

  it('gán tag theo module khi route không tự ghi tags', () => {
    expect(document.paths?.['/api/v1/catalog/products/{productId}']?.get?.tags).toEqual(['catalog']);
    expect(document.paths?.['/api/v1/catalog']?.get?.tags).toEqual(['khac']);
  });

  it('đưa schema có id và ProblemDetails vào components', () => {
    expect(document.openapi).toBe('3.1.0');
    expect(Object.keys(document.components?.schemas ?? {})).toEqual(expect.arrayContaining(['Product', 'ProblemDetails']));
  });
});
