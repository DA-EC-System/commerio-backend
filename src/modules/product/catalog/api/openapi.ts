import type { OpenAPIRegistry, RouteConfig } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { problemResponse } from '../../../../shared/http/openapi.ts';
import {
  AddVariantBody,
  Attribute,
  AttributeBody,
  Category,
  CategoryBody,
  CreateProductBody,
  IdParams,
  ProductDetail,
  ProductListQuery,
  ProductPage,
  UpdateAttributeBody,
  UpdateCategoryBody,
  UpdateProductBody,
  Variant,
  VariantParams,
  VersionQuery,
} from './schemas.ts';

const json = (description: string, schema: z.ZodType) => ({ description, content: { 'application/json': { schema } } });
const body = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
const noContent = { description: 'Đã xong' };

// Lỗi chung của mọi route: kiểm quyền (src/shared/auth/authorize.ts) và công ty khác (C4).
const common = {
  401: problemResponse('Chưa đăng nhập'),
  403: problemResponse('Chưa chọn công ty, công ty hoặc tài khoản bị khoá, hoặc thiếu quyền (`forbidden`)'),
};
const invalid = { 422: problemResponse('Dữ liệu không hợp lệ (`validation_failed`, `errors` theo ô)') };
const missing = (what: string) => ({ 404: problemResponse(`Không tìm thấy ${what} (kể cả của công ty khác)`) });

/** Đường dẫn Swagger của module `catalog`, viết tương đối với /api/v1/catalog (Documents/21 5.2, 5.3). */
export function registerCatalogOpenApi(registry: OpenAPIRegistry): void {
  const path = (route: RouteConfig) => registry.registerPath({ ...route, responses: { ...common, ...route.responses } });

  // ----- Danh mục: quyền xem `catalog.product.view`, ghi `catalog.category.manage` -----
  path({
    method: 'get',
    path: '/categories',
    summary: 'Danh sách danh mục kèm quy tắc SKU',
    responses: { 200: json('Danh mục, sắp theo tên', z.array(Category)) },
  });
  path({
    method: 'post',
    path: '/categories',
    summary: 'Tạo danh mục',
    request: { body: body(CategoryBody) },
    responses: { 201: json('Danh mục vừa tạo', Category), 409: problemResponse('Tên đã dùng (`name_taken`)'), ...invalid },
  });
  path({
    method: 'put',
    path: '/categories/:id',
    summary: 'Sửa danh mục; quy tắc mới chỉ áp dụng cho SKU sinh sau',
    request: { params: IdParams, body: body(UpdateCategoryBody) },
    responses: {
      200: json('Danh mục sau khi sửa', Category),
      409: problemResponse('`version_conflict` (kèm `current`) hoặc `name_taken`'),
      ...missing('danh mục'),
      ...invalid,
    },
  });
  path({
    method: 'delete',
    path: '/categories/:id',
    summary: 'Xoá danh mục chưa có sản phẩm nào (kể cả đã lưu trữ)',
    request: { params: IdParams, query: VersionQuery },
    responses: {
      204: noContent,
      409: problemResponse('`in_use` hoặc `version_conflict`'),
      ...missing('danh mục'),
      ...invalid,
    },
  });

  // ----- Thuộc tính -----
  path({
    method: 'get',
    path: '/attributes',
    summary: 'Danh sách thuộc tính và giá trị',
    responses: { 200: json('Thuộc tính theo thứ tự tạo', z.array(Attribute)) },
  });
  path({
    method: 'post',
    path: '/attributes',
    summary: 'Tạo thuộc tính',
    request: { body: body(AttributeBody) },
    responses: { 201: json('Thuộc tính vừa tạo', Attribute), 409: problemResponse('Tên đã dùng (`name_taken`)'), ...invalid },
  });
  path({
    method: 'put',
    path: '/attributes/:id',
    summary: 'Sửa thuộc tính; giá trị cũ vắng mặt bị xoá, không có `id` là giá trị mới',
    request: { params: IdParams, body: body(UpdateAttributeBody) },
    responses: {
      200: json('Thuộc tính sau khi sửa', Attribute),
      409: problemResponse('`version_conflict`, `name_taken`, hoặc `in_use` (bỏ giá trị đang dùng)'),
      ...missing('thuộc tính'),
      ...invalid,
    },
  });
  path({
    method: 'delete',
    path: '/attributes/:id',
    summary: 'Xoá thuộc tính chưa có biến thể dùng',
    request: { params: IdParams, query: VersionQuery },
    responses: {
      204: noContent,
      409: problemResponse('`in_use` hoặc `version_conflict`'),
      ...missing('thuộc tính'),
      ...invalid,
    },
  });

  // ----- Sản phẩm: xem `catalog.product.view`, ghi `catalog.product.manage` -----
  path({
    method: 'get',
    path: '/products',
    summary: 'Danh sách sản phẩm; `search` khớp tên hoặc SKU',
    request: { query: ProductListQuery },
    responses: { 200: json('Một trang sản phẩm', ProductPage), ...invalid },
  });
  path({
    method: 'get',
    path: '/products/:id',
    summary: 'Chi tiết sản phẩm kèm mọi biến thể (kể cả ngừng bán)',
    request: { params: IdParams },
    responses: { 200: json('Sản phẩm', ProductDetail), ...missing('sản phẩm') },
  });
  path({
    method: 'post',
    path: '/products',
    summary: 'Tạo sản phẩm; SKU sinh theo quy tắc của danh mục, theo thứ tự biến thể',
    request: { body: body(CreateProductBody) },
    responses: { 201: json('Sản phẩm vừa tạo', ProductDetail), 409: problemResponse('Tên đã dùng (`name_taken`)'), ...invalid },
  });
  path({
    method: 'put',
    path: '/products/:id',
    summary: 'Sửa tên, mô tả; không đổi danh mục và biến thể',
    request: { params: IdParams, body: body(UpdateProductBody) },
    responses: {
      200: json('Sản phẩm sau khi sửa', ProductDetail),
      409: problemResponse('`product_archived`, `version_conflict` (kèm `current`) hoặc `name_taken`'),
      ...missing('sản phẩm'),
      ...invalid,
    },
  });
  path({
    method: 'delete',
    path: '/products/:id',
    summary: 'Lưu trữ sản phẩm',
    request: { params: IdParams, query: VersionQuery },
    responses: {
      204: noContent,
      409: problemResponse('`product_archived` hoặc `version_conflict`'),
      ...missing('sản phẩm'),
      ...invalid,
    },
  });
  path({
    method: 'post',
    path: '/products/:id/variants',
    summary: 'Thêm biến thể; tổ hợp từng ngừng bán thì bán lại với SKU cũ',
    request: { params: IdParams, body: body(AddVariantBody) },
    responses: {
      200: json('Biến thể được bán lại (SKU cũ)', Variant),
      201: json('Biến thể mới', Variant),
      409: problemResponse('`variant_exists` hoặc `product_archived`'),
      ...missing('sản phẩm'),
      ...invalid,
    },
  });
  path({
    method: 'delete',
    path: '/products/:id/variants/:variantId',
    summary: 'Ngừng bán biến thể; SKU không cấp lại',
    request: { params: VariantParams },
    responses: {
      204: noContent,
      409: problemResponse('`last_variant` hoặc `product_archived`'),
      ...missing('biến thể đang bán'),
    },
  });
}
