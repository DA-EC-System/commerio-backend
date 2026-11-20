import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '#src/app.ts';

// Swagger của catalog sau #447 (AC-S6): nhóm hàng, chuyển sản phẩm, cài đặt; không còn danh mục nội bộ.
describe('OpenAPI catalog (#447)', () => {
  it('có /catalog/groups, /catalog/groups/{id}/move-products, /catalog/settings; không còn /catalog/categories', async () => {
    const res = await request(createApp()).get('/api/openapi.json');
    const paths = Object.keys(res.body.paths);
    expect(paths).toEqual(expect.arrayContaining(['/api/v1/catalog/groups', '/api/v1/catalog/groups/{id}/move-products', '/api/v1/catalog/settings']));
    expect(paths.filter((p) => p.startsWith('/api/v1/catalog/categories'))).toEqual([]);
    expect(res.body.components.schemas.CreateProductRequest.properties).toHaveProperty('axes');
  });
});
