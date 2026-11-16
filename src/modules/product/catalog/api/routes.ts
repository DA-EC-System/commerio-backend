import { type Response, Router } from 'express';
import { getAuth } from '../../../../shared/auth/authenticate.ts';
import { getAccess } from '../../../../shared/auth/authorize.ts';
import { moduleOfPermission } from '../../../../shared/auth/company-access.ts';
import { validate, validated } from '../../../../shared/http/validate.ts';
import * as attributes from '../service/attributes.ts';
import * as categories from '../service/categories.ts';
import { type BusinessActor, changeBusinessStatus } from '../service/business-status.ts';
import { type BulkEditContext, type BulkViewer, listBulkEdit, saveBulkEdit } from '../service/bulk-edit.ts';
import * as products from '../service/products.ts';
import { addVariant, updateVariant } from '../service/variants.ts';
import type { Caller } from '../service/errors.ts';
import type { CatalogContext } from '../service/standard-price.ts';
import {
  AddVariantBody,
  AttributeBody,
  BusinessStatusBody,
  BulkEditQuery,
  BulkSaveBody,
  CategoryBody,
  CreateProductBody,
  IdParams,
  ProductListQuery,
  UpdateAttributeBody,
  UpdateCategoryBody,
  UpdateProductBody,
  UpdateVariantBody,
  VariantParams,
  VersionQuery,
} from './schemas.ts';

function caller(res: Response): Caller {
  const { accountId, companyId } = getAuth(res);
  return { accountId, companyId: companyId! };
}

const MANAGE = 'catalog.product.manage';

/** Quyền phụ của route (`getAccess`, đọc DB lúc `authorize`); quyền của phân hệ đang tắt không tính. */
function can(res: Response, permission: string): boolean {
  const { permissions, enabledModules } = getAccess(res);
  return permissions.includes(permission) && enabledModules.includes(moduleOfPermission(permission));
}

/** Người làm cho máy trạng thái: quyền và phân hệ đang bật lấy nguyên từ `getAccess` (khung tự bỏ quyền phân hệ tắt). */
function actor(res: Response): BusinessActor {
  const { permissions, enabledModules } = getAccess(res);
  return { ...caller(res), permissions, enabledModules };
}

function bulkViewer(res: Response): BulkViewer {
  return { ...caller(res), permissions: getAccess(res).permissions };
}

/**
 * Route của module `catalog`, gắn tại /api/v1/catalog (Documents/21 5.2). Kiểm quyền bằng `ctx.authorize(...)`
 * trước `validate()`; giá chuẩn của chi tiết sản phẩm lấy bằng `standardPricesOf(ctx, …)`.
 */
export function catalogRouter(ctx: CatalogContext): Router {
  const router = Router();
  const view = ctx.authorize('catalog.product.view');
  const setup = ctx.authorize('catalog.category.manage');
  const manage = ctx.authorize(MANAGE);

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

  // Sửa hàng loạt có gợi ý (#242, Documents/21 §17.5). Khai trước `/products` cho gọn; không trùng đường dẫn nào.
  router.get('/variants/bulk-edit', manage, validate({ query: BulkEditQuery }), async (_req, res) => {
    res.json(await listBulkEdit(ctx as BulkEditContext, bulkViewer(res), validated<typeof BulkEditQuery>(res, 'query')));
  });

  router.patch('/variants/bulk', manage, validate({ body: BulkSaveBody }), async (_req, res) => {
    res.json(await saveBulkEdit(ctx as BulkEditContext, bulkViewer(res), validated<typeof BulkSaveBody>(res, 'body').rows));
  });

  router.get('/products', view, validate({ query: ProductListQuery }), async (_req, res) => {
    res.json(await products.listProducts(ctx, caller(res).companyId, validated<typeof ProductListQuery>(res, 'query')));
  });

  router.get('/products/:id', view, validate({ params: IdParams }), async (_req, res) => {
    const { id } = validated<typeof IdParams>(res, 'params');
    res.json(await products.getProduct(ctx, caller(res).companyId, id, { archiveBlockers: can(res, MANAGE) }));
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
    await products.deleteProduct(ctx, caller(res), id, validated<typeof VersionQuery>(res, 'query').version);
    res.status(204).end();
  });

  router.post('/products/:id/variants', manage, validate({ params: IdParams, body: AddVariantBody }), async (_req, res) => {
    const { id } = validated<typeof IdParams>(res, 'params');
    const { attributeValueIds } = validated<typeof AddVariantBody>(res, 'body');
    res.status(201).json(await addVariant(ctx, caller(res), id, attributeValueIds));
  });

  // Đổi trạng thái kinh doanh của SKU hoặc cả sản phẩm (#204, Documents/21 §17.2, §17.3).
  router.post('/products/:id/business-status', manage, validate({ params: IdParams, body: BusinessStatusBody }), async (_req, res) => {
    const { id } = validated<typeof IdParams>(res, 'params');
    res.json(await changeBusinessStatus(ctx, actor(res), id, validated<typeof BusinessStatusBody>(res, 'body')));
  });

  // Sửa giá, cân nặng, kích thước của một SKU; `version` là của SKU (#204, Documents/21 §17.2).
  router.patch(
    '/products/:id/variants/:variantId',
    manage,
    validate({ params: VariantParams, body: UpdateVariantBody }),
    async (_req, res) => {
      const { id, variantId } = validated<typeof VariantParams>(res, 'params');
      res.json(await updateVariant(ctx, caller(res), id, variantId, validated<typeof UpdateVariantBody>(res, 'body')));
    },
  );

  return router;
}
