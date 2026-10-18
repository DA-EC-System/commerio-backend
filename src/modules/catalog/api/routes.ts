import { type Response, Router } from 'express';
import type { z } from 'zod';
import { getAuth } from '../../../shared/auth/authenticate.ts';
import { validate } from '../../../shared/http/validate.ts';
import * as attributes from '../service/attributes.ts';
import * as categories from '../service/categories.ts';
import * as products from '../service/products.ts';
import { addVariant, archiveVariant } from '../service/variants.ts';
import type { Caller } from '../service/errors.ts';
import type { CatalogContext } from '../service/standard-price.ts';
import {
  AddVariantBody,
  AttributeBody,
  CategoryBody,
  CreateProductBody,
  IdParams,
  ProductListQuery,
  UpdateAttributeBody,
  UpdateCategoryBody,
  UpdateProductBody,
  VariantParams,
  VersionQuery,
} from './schemas.ts';

const validated = <T extends z.ZodType>(res: Response, part: 'body' | 'query' | 'params') =>
  (res.locals.validated as Record<string, z.output<T>>)[part]!;

function caller(res: Response): Caller {
  const { accountId, companyId } = getAuth(res);
  return { accountId, companyId: companyId! };
}

/**
 * Route của module `catalog`, gắn tại /api/v1/catalog (Documents/21 5.2). Kiểm quyền bằng `ctx.authorize(...)`
 * trước `validate()`; giá chuẩn của chi tiết sản phẩm lấy bằng `standardPricesOf(ctx, …)`.
 */
export function catalogRouter(ctx: CatalogContext): Router {
  const router = Router();
  const view = ctx.authorize('catalog.product.view');
  const setup = ctx.authorize('catalog.category.manage');
  const manage = ctx.authorize('catalog.product.manage');

  router.get('/categories', view, async (_req, res) => {
    res.json(await categories.listCategories(caller(res).companyId));
  });

  router.post('/categories', setup, validate({ body: CategoryBody }), async (_req, res) => {
    res.status(201).json(await categories.createCategory(caller(res), validated<typeof CategoryBody>(res, 'body')));
  });

  router.put('/categories/:id', setup, validate({ params: IdParams, body: UpdateCategoryBody }), async (_req, res) => {
    const { id } = validated<typeof IdParams>(res, 'params');
    res.json(await categories.updateCategory(caller(res), id, validated<typeof UpdateCategoryBody>(res, 'body')));
  });

  router.delete('/categories/:id', setup, validate({ params: IdParams, query: VersionQuery }), async (_req, res) => {
    const { id } = validated<typeof IdParams>(res, 'params');
    await categories.deleteCategory(caller(res), id, validated<typeof VersionQuery>(res, 'query').version);
    res.status(204).end();
  });

  router.get('/attributes', view, async (_req, res) => {
    res.json(await attributes.listAttributes(caller(res).companyId));
  });

  router.post('/attributes', setup, validate({ body: AttributeBody }), async (_req, res) => {
    res.status(201).json(await attributes.createAttribute(caller(res), validated<typeof AttributeBody>(res, 'body')));
  });

  router.put('/attributes/:id', setup, validate({ params: IdParams, body: UpdateAttributeBody }), async (_req, res) => {
    const { id } = validated<typeof IdParams>(res, 'params');
    res.json(await attributes.updateAttribute(caller(res), id, validated<typeof UpdateAttributeBody>(res, 'body')));
  });

  router.delete('/attributes/:id', setup, validate({ params: IdParams, query: VersionQuery }), async (_req, res) => {
    const { id } = validated<typeof IdParams>(res, 'params');
    await attributes.deleteAttribute(caller(res), id, validated<typeof VersionQuery>(res, 'query').version);
    res.status(204).end();
  });

  router.get('/products', view, validate({ query: ProductListQuery }), async (_req, res) => {
    res.json(await products.listProducts(caller(res).companyId, validated<typeof ProductListQuery>(res, 'query')));
  });

  router.get('/products/:id', view, validate({ params: IdParams }), async (_req, res) => {
    const { id } = validated<typeof IdParams>(res, 'params');
    res.json(await products.getProduct(ctx, caller(res).companyId, id));
  });

  router.post('/products', manage, validate({ body: CreateProductBody }), async (_req, res) => {
    res.status(201).json(await products.createProduct(ctx, caller(res), validated<typeof CreateProductBody>(res, 'body')));
  });

  router.put('/products/:id', manage, validate({ params: IdParams, body: UpdateProductBody }), async (_req, res) => {
    const { id } = validated<typeof IdParams>(res, 'params');
    res.json(await products.updateProduct(ctx, caller(res), id, validated<typeof UpdateProductBody>(res, 'body')));
  });

  router.delete('/products/:id', manage, validate({ params: IdParams, query: VersionQuery }), async (_req, res) => {
    const { id } = validated<typeof IdParams>(res, 'params');
    await products.archiveProduct(ctx, caller(res), id, validated<typeof VersionQuery>(res, 'query').version);
    res.status(204).end();
  });

  router.post('/products/:id/variants', manage, validate({ params: IdParams, body: AddVariantBody }), async (_req, res) => {
    const { id } = validated<typeof IdParams>(res, 'params');
    const { attributeValueIds } = validated<typeof AddVariantBody>(res, 'body');
    const { created, variant } = await addVariant(ctx, caller(res), id, attributeValueIds);
    res.status(created ? 201 : 200).json(variant);
  });

  // Ngừng bán không nhận `version` (Documents/21 5.2, P7; plan #12 B3).
  router.delete('/products/:id/variants/:variantId', manage, validate({ params: VariantParams }), async (_req, res) => {
    const { id, variantId } = validated<typeof VariantParams>(res, 'params');
    await archiveVariant(caller(res), id, variantId);
    res.status(204).end();
  });

  return router;
}
