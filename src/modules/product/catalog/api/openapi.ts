import type { OpenAPIRegistry, RouteConfig } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { problemResponse } from '../../../../shared/http/openapi.ts';
import {
  AddVariantBody,
  Attribute,
  AttributeBody,
  BusinessStatusBody,
  BusinessStatusResult,
  BulkEditPage,
  BulkEditQuery,
  BulkSaveDocBody,
  BulkSaveResult,
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
  UpdateVariantBody,
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
      409: problemResponse(
        '`version_conflict` (kèm `current`), `name_taken`, hoặc `listing_field_required` (`imageFileIds` rỗng khi có SKU còn listing chưa gỡ; `errors.images`)',
      ),
      ...missing('sản phẩm'),
      ...invalid,
    },
  });
  path({
    method: 'delete',
    path: '/products/:id',
    summary: 'Xoá hẳn sản phẩm chờ hoàn thiện chưa dùng',
    description:
      'Chỉ khi mọi SKU `incomplete`, chưa có ở chứng từ, đơn, listing, lần tính giá nào, không sinh từ đề nghị nhập. Xoá biến ' +
      'thể, ảnh gắn (không xoá tệp), danh mục sàn, dòng tồn. Lưu trữ sản phẩm cha kiểu cũ đã bỏ: lưu trữ từng SKU bằng ' +
      '`POST /products/:id/business-status`.',
    request: { params: IdParams, query: VersionQuery },
    responses: {
      204: noContent,
      409: problemResponse('`product_in_use` hoặc `version_conflict` (kèm `current`)'),
      ...missing('sản phẩm'),
      ...invalid,
    },
  });
  path({
    method: 'post',
    path: '/products/:id/variants',
    summary: 'Thêm biến thể; tổ hợp của SKU đã lưu trữ thì 409 variant_archived (dùng Khôi phục)',
    request: { params: IdParams, body: body(AddVariantBody) },
    responses: {
      201: json('Biến thể mới', Variant),
      409: problemResponse('`variant_exists` hoặc `variant_archived` (kèm `variantId`)'),
      ...missing('sản phẩm'),
      ...invalid,
    },
  });
  path({
    method: 'post',
    path: '/products/:id/business-status',
    summary: 'Đổi trạng thái kinh doanh của SKU; bỏ variantIds là áp cho mọi SKU con',
    description:
      'Thao tác theo sơ đồ B1 (Documents/21 §17.3). Nhiều SKU: SKU không làm được nằm ở `skipped`. Đúng một `variantIds` mà ' +
      'không làm được thì 409. Mỗi SKU đổi phát `catalog.variant_status_changed`.',
    request: { params: IdParams, body: body(BusinessStatusBody) },
    responses: {
      200: json('Sản phẩm sau khi đổi, SKU đã đổi và SKU bỏ qua', BusinessStatusResult),
      409: problemResponse('`invalid_transition` (kèm `current`) hoặc `archive_blocked` (kèm `reasons`)'),
      ...missing('sản phẩm'),
      ...invalid,
    },
  });
  path({
    method: 'patch',
    path: '/products/:id/variants/:variantId',
    summary: 'Sửa giá, cân nặng, kích thước của một SKU; bỏ trường là giữ, null là xoá',
    description:
      '`version` là của SKU (`variants[].version`). Không trường nào khác giá trị đang lưu thì không ghi, trả bản hiện tại. ' +
      'Đổi `targetNetPrice` phát `catalog.variant_price_changed` (Documents/21 §11.2); đổi `standardPrice` không phát. ' +
      'SKU còn listing chưa gỡ thì không xoá trống `targetNetPrice`, `weightG`, `lengthMm`, `widthMm`, `heightMm` (US-SP-03 dòng 7).',
    request: { params: VariantParams, body: body(UpdateVariantBody) },
    responses: {
      200: json('Sản phẩm sau khi sửa', ProductDetail),
      409: problemResponse('`version_conflict` (kèm `current`) hoặc `listing_field_required` (kèm `errors` theo trường bị xoá trống)'),
      ...missing('sản phẩm hoặc biến thể'),
      ...invalid,
    },
  });
  path({
    method: 'get',
    path: '/variants/bulk-edit',
    summary: 'Lấy SKU để sửa hàng loạt, kèm giá trị gợi ý (không tự lưu)',
    description:
      'Chỉ SKU chưa lưu trữ của sản phẩm chưa lưu trữ. `incomplete=true`: còn ít nhất một ô giá muốn bán, cân nặng, dài, rộng, cao bỏ trống. ' +
      '`suggestions` chỉ có cho ô đang trống: giá muốn bán = giá nhập × hệ số lãi của danh mục (làm tròn lên theo bước của danh mục), ' +
      'không có thì chép từ SKU anh em; ngưỡng tồn theo tốc độ bán 30 ngày hoặc mặc định danh mục; cân nặng, kích thước, giá chuẩn chép từ SKU anh em. ' +
      '`source.lastCost` là null khi thiếu quyền `inventory.cost.view`.',
    request: { query: BulkEditQuery },
    responses: { 200: json('Trang SKU kèm gợi ý', BulkEditPage), ...invalid },
  });
  path({
    method: 'patch',
    path: '/variants/bulk',
    summary: 'Lưu nhiều SKU một lần; lỗi theo dòng, dòng lỗi không chặn dòng khác',
    description:
      'Tối đa 200 dòng (vượt thì 400 `too_many_rows`). Luôn 200 với `{ saved, failed }`. Mỗi dòng ghi trong giao dịch riêng: dòng lỗi không ghi gì, các dòng khác vẫn ghi. ' +
      'Chỉ gửi ô người dùng đã sửa hoặc đã nhận gợi ý; null là xoá giá trị. Đổi `targetNetPrice` phát `catalog.variant_price_changed` cho từng SKU. ' +
      '`minQty` cần `inventory.reorder.manage` và `reorderVersion`. Dòng xoá trống giá muốn bán, cân nặng, kích thước của SKU còn ' +
      'listing chưa gỡ lỗi `listing_field_required` kèm `errors`.',
    request: { body: body(BulkSaveDocBody) },
    responses: { 200: json('Kết quả theo dòng', BulkSaveResult), 400: problemResponse('`too_many_rows`'), ...invalid },
  });
}
