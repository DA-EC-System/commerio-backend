import { type Response, Router } from 'express';
import { getAuth } from '../../../../shared/auth/authenticate.ts';
import { anyOf, getAccess } from '../../../../shared/auth/authorize.ts';
import { moduleOfPermission } from '../../../../shared/auth/company-access.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { validate, validated } from '../../../../shared/http/validate.ts';
import * as attributes from '../service/attributes.ts';
import * as groups from '../service/groups.ts';
import { addTemplateField, getGroupTemplate, putGroupTemplate } from '../service/group-templates.ts';
import * as specFields from '../service/spec-fields.ts';
import * as settings from '../service/settings.ts';
import { type BusinessActor, changeBusinessStatus } from '../service/business-status.ts';
import { type BulkEditContext, type BulkViewer, listBulkEdit, saveBulkEdit } from '../service/bulk-edit.ts';
import * as products from '../service/products.ts';
import { removeVariantImage, setVariantImage } from '../service/variant-images.ts';
import { addVariant, updateVariant } from '../service/variants.ts';
import type { Caller } from '../service/errors.ts';
import type { CatalogContext } from '../service/standard-price.ts';
import {
  AddVariantBody,
  AttributeBody,
  AttributesQuery,
  BusinessStatusBody,
  BulkEditQuery,
  BulkSaveBody,
  CreateProductBody,
  AttributeValueBody,
  AttributeValueParams,
  GroupBody,
  GroupHiddenBody,
  GroupListQuery,
  GroupTemplateBody,
  SpecOptionBody,
  TemplateFieldBody,
  SpecOptionParams,
  MoveProductsBody,
  IdParams,
  ProductListQuery,
  SetVariantImageBody,
  SettingsBody,
  SpecFieldBody,
  UpdateAttributeBody,
  UpdateGroupBody,
  UpdateProductBody,
  UpdateSpecFieldBody,
  UpdateVariantBody,
  VariantImageParams,
  VariantParams,
  VersionQuery,
} from './schemas.ts';

function caller(res: Response): Caller {
  const { accountId, companyId } = getAuth(res);
  return { accountId, companyId: companyId! };
}

const MANAGE = 'catalog.product.manage';
const SETUP = 'catalog.group.manage';

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
  const setup = ctx.authorize(SETUP);
  const manage = ctx.authorize(MANAGE);
  // Tạo nhanh nhóm (chỉ tên) từ form sản phẩm, đề nghị nhập (21 mục 5.2). `purchasing.request.manage` đứng cuối: `anyOf`
  // chỉ thử tiếp khi `forbidden`, phân hệ purchasing tắt thì `module_disabled` trả ngay.
  const quickGroup = anyOf(setup, manage, ctx.authorize('purchasing.request.manage'));

  router.get('/groups', view, validate({ query: GroupListQuery }), async (_req, res) => {
    const { includeHidden } = validated<typeof GroupListQuery>(res, 'query');
    res.json(await groups.listGroups(caller(res).companyId, { includeHidden }));
  });

  // Ẩn, hiện nhóm nền tảng cho công ty (Documents/21 mục 5.6).
  router.put('/groups/:id/hidden', setup, validate({ params: IdParams, body: GroupHiddenBody }), async (_req, res) => {
    const { id } = validated<typeof IdParams>(res, 'params');
    res.json(await groups.setHidden(caller(res), id, validated<typeof GroupHiddenBody>(res, 'body').hidden));
  });

  router.post('/groups', quickGroup, validate({ body: GroupBody }), async (_req, res) => {
    const input = validated<typeof GroupBody>(res, 'body');
    if (input.suggest !== undefined && !can(res, SETUP)) {
      throw new AppError(403, 'forbidden', 'Bạn không có quyền đặt gợi ý của nhóm hàng');
    }
    if (input.copyTemplateFromGroupId !== undefined && !can(res, SETUP)) {
      throw new AppError(403, 'forbidden', 'Bạn không có quyền chép mẫu thông số của nhóm hàng');
    }
    res.status(201).json(await groups.createGroup(caller(res), input));
  });

  router.put('/groups/:id', setup, validate({ params: IdParams, body: UpdateGroupBody }), async (_req, res) => {
    const { id } = validated<typeof IdParams>(res, 'params');
    res.json(await groups.updateGroup(caller(res), id, validated<typeof UpdateGroupBody>(res, 'body')));
  });

  router.delete('/groups/:id', setup, validate({ params: IdParams, query: VersionQuery }), async (_req, res) => {
    const { id } = validated<typeof IdParams>(res, 'params');
    await groups.deleteGroup(caller(res), id, validated<typeof VersionQuery>(res, 'query').version);
    res.status(204).end();
  });

  router.post('/groups/:id/move-products', manage, validate({ params: IdParams, body: MoveProductsBody }), async (_req, res) => {
    const { id } = validated<typeof IdParams>(res, 'params');
    res.json(await groups.moveProducts(caller(res), id, validated<typeof MoveProductsBody>(res, 'body')));
  });

  // Mẫu thông số và trục chuẩn của nhóm (#510, Documents/21 mục 5.5).
  router.get('/groups/:id/template', view, validate({ params: IdParams }), async (_req, res) => {
    const { id } = validated<typeof IdParams>(res, 'params');
    res.json(await getGroupTemplate(caller(res).companyId, id));
  });

  router.put('/groups/:id/template', setup, validate({ params: IdParams, body: GroupTemplateBody }), async (_req, res) => {
    const { id } = validated<typeof IdParams>(res, 'params');
    res.json(await putGroupTemplate(caller(res), id, validated<typeof GroupTemplateBody>(res, 'body')));
  });

  // Tạo hoặc chọn thông số rồi gắn vào cuối mẫu, một giao dịch (Documents/21 mục 5.6).
  router.post('/groups/:id/template/fields', setup, validate({ params: IdParams, body: TemplateFieldBody }), async (_req, res) => {
    const { id } = validated<typeof IdParams>(res, 'params');
    res.json(await addTemplateField(caller(res), id, validated<typeof TemplateFieldBody>(res, 'body')));
  });

  // Thư viện thông số (#510, Documents/21 mục 5.5).
  router.get('/spec-fields', view, async (_req, res) => {
    res.json(await specFields.listSpecFields(caller(res).companyId));
  });

  router.post('/spec-fields', setup, validate({ body: SpecFieldBody }), async (_req, res) => {
    res.status(201).json(await specFields.createSpecField(caller(res), validated<typeof SpecFieldBody>(res, 'body')));
  });

  router.put('/spec-fields/:id', setup, validate({ params: IdParams, body: UpdateSpecFieldBody }), async (_req, res) => {
    const { id } = validated<typeof IdParams>(res, 'params');
    res.json(await specFields.updateSpecField(caller(res), id, validated<typeof UpdateSpecFieldBody>(res, 'body')));
  });

  // Lựa chọn riêng của công ty trên thông số nền tảng (Documents/21 mục 5.6).
  router.post('/spec-fields/:id/options', setup, validate({ params: IdParams, body: SpecOptionBody }), async (_req, res) => {
    const { id } = validated<typeof IdParams>(res, 'params');
    res.status(201).json(await specFields.addSpecOption(caller(res), id, validated<typeof SpecOptionBody>(res, 'body').value));
  });

  router.delete('/spec-fields/:id/options/:optionId', setup, validate({ params: SpecOptionParams }), async (_req, res) => {
    const { id, optionId } = validated<typeof SpecOptionParams>(res, 'params');
    await specFields.removeSpecOption(caller(res), id, optionId);
    res.status(204).end();
  });

  router.delete('/spec-fields/:id', setup, validate({ params: IdParams, query: VersionQuery }), async (_req, res) => {
    const { id } = validated<typeof IdParams>(res, 'params');
    await specFields.deleteSpecField(caller(res), id, validated<typeof VersionQuery>(res, 'query').version);
    res.status(204).end();
  });

  router.get('/settings', view, async (_req, res) => {
    res.json(await settings.getSettings(caller(res).companyId));
  });

  router.put('/settings', setup, validate({ body: SettingsBody }), async (_req, res) => {
    res.json(await settings.updateSettings(caller(res), validated<typeof SettingsBody>(res, 'body')));
  });

  router.get('/attributes', view, validate({ query: AttributesQuery }), async (_req, res) => {
    res.json(await attributes.listAttributes(caller(res).companyId, validated<typeof AttributesQuery>(res, 'query')));
  });

  router.post('/attributes', setup, validate({ body: AttributeBody }), async (_req, res) => {
    res.status(201).json(await attributes.createAttribute(caller(res), validated<typeof AttributeBody>(res, 'body')));
  });

  router.put('/attributes/:id', setup, validate({ params: IdParams, body: UpdateAttributeBody }), async (_req, res) => {
    const { id } = validated<typeof IdParams>(res, 'params');
    res.json(await attributes.updateAttribute(caller(res), id, validated<typeof UpdateAttributeBody>(res, 'body')));
  });

  // Giá trị riêng của công ty trên thuộc tính nền tảng (Documents/21 mục 5.6).
  router.post('/attributes/:id/values', setup, validate({ params: IdParams, body: AttributeValueBody }), async (_req, res) => {
    const { id } = validated<typeof IdParams>(res, 'params');
    res.status(201).json(await attributes.addAttributeValue(caller(res), id, validated<typeof AttributeValueBody>(res, 'body')));
  });

  router.delete('/attributes/:id/values/:valueId', setup, validate({ params: AttributeValueParams }), async (_req, res) => {
    const { id, valueId } = validated<typeof AttributeValueParams>(res, 'params');
    await attributes.removeAttributeValue(caller(res), id, valueId);
    res.status(204).end();
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

  // Ảnh phân loại theo giá trị của thuộc tính gắn ảnh (#340, Documents/21 §17.2); không nhận `version`.
  const imagePath = '/products/:id/attribute-value-images/:attributeValueId';
  router.put(imagePath, manage, validate({ params: VariantImageParams, body: SetVariantImageBody }), async (_req, res) => {
    const { id, attributeValueId } = validated<typeof VariantImageParams>(res, 'params');
    const { fileId } = validated<typeof SetVariantImageBody>(res, 'body');
    res.json(await setVariantImage(ctx, caller(res), id, attributeValueId, fileId));
  });

  router.delete(imagePath, manage, validate({ params: VariantImageParams }), async (_req, res) => {
    const { id, attributeValueId } = validated<typeof VariantImageParams>(res, 'params');
    res.json(await removeVariantImage(ctx, caller(res), id, attributeValueId));
  });

  return router;
}
