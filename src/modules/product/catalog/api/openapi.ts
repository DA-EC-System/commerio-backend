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
  CreateProductBody,
  IdParams,
  ProductDetail,
  ProductListQuery,
  ProductPage,
  SetVariantImageBody,
  UpdateAttributeBody,
  UpdateGroupBody,
  UpdateProductBody,
  UpdateVariantBody,
  Variant,
  VariantImageParams,
  VariantParams,
  VersionQuery,
  GroupBody,
  GroupTemplate,
  GroupTemplateBody,
  SpecField,
  SpecFieldBody,
  UpdateSpecFieldBody,
  MoveProductsBody,
  ProductGroup,
  ProductSettings,
  SettingsBody,
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

  // ----- Nhóm hàng, cài đặt sản phẩm: xem `catalog.product.view`, ghi `catalog.group.manage` (21 mục 5.2) -----
  path({
    method: 'get',
    path: '/groups',
    summary: 'Danh sách nhóm hàng',
    responses: { 200: json('Nhóm hàng, sắp theo tên', z.object({ items: z.array(ProductGroup) })) },
  });
  path({
    method: 'post',
    path: '/groups',
    summary: 'Tạo nhóm hàng; chỉ gửi tên thì `catalog.product.manage` hoặc `purchasing.request.manage` cũng được',
    request: { body: body(GroupBody) },
    responses: { 201: json('Nhóm vừa tạo', ProductGroup), 409: problemResponse('Tên đã dùng (`name_taken`)'), ...invalid },
  });
  path({
    method: 'put',
    path: '/groups/:id',
    summary: 'Sửa nhóm hàng',
    request: { params: IdParams, body: body(UpdateGroupBody) },
    responses: {
      200: json('Nhóm sau khi sửa', ProductGroup),
      409: problemResponse('`version_conflict` (kèm `current`) hoặc `name_taken`'),
      ...missing('nhóm hàng'),
      ...invalid,
    },
  });
  path({
    method: 'delete',
    path: '/groups/:id',
    summary: 'Xoá nhóm hàng chưa có sản phẩm nào (kể cả đã lưu trữ)',
    request: { params: IdParams, query: VersionQuery },
    responses: { 204: noContent, 409: problemResponse('`in_use` hoặc `version_conflict`'), ...missing('nhóm hàng'), ...invalid },
  });
  path({
    method: 'post',
    path: '/groups/:id/move-products',
    summary: 'Chuyển sản phẩm (kể cả đã lưu trữ) sang nhóm khác; quyền `catalog.product.manage`',
    request: { params: IdParams, body: body(MoveProductsBody) },
    responses: {
      200: json('Số sản phẩm đã chuyển', z.object({ moved: z.number().int() })),
      ...missing('nhóm hàng nguồn'),
      422: problemResponse('`errors.targetGroupId` (trùng nguồn, không có) hoặc `errors.productIds` (không thuộc nhóm)'),
    },
  });
  // ----- Thông số sản phẩm (#510, Documents/21 mục 5.5) -----
  path({
    method: 'get',
    path: '/groups/:id/template',
    summary: 'Mẫu thông số và trục chuẩn của nhóm (form tạo sản phẩm gọi khi chọn nhóm)',
    request: { params: IdParams },
    responses: { 200: json('Mẫu nhóm', GroupTemplate), ...missing('nhóm hàng') },
  });
  path({
    method: 'put',
    path: '/groups/:id/template',
    summary: 'Đặt mẫu thông số và trục chuẩn của nhóm; tăng `version` nhóm. Không chạm sản phẩm',
    request: { params: IdParams, body: body(GroupTemplateBody) },
    responses: {
      200: json('Mẫu sau khi sửa', GroupTemplate),
      409: problemResponse('`version_conflict` (kèm `current` là mẫu mới nhất)'),
      ...missing('nhóm hàng'),
      422: problemResponse('`errors.axisAttributeIds`, `errors["fields.<i>.fieldId"]`'),
    },
  });
  path({
    method: 'get',
    path: '/spec-fields',
    summary: 'Thư viện thông số của công ty, xếp theo tên',
    responses: { 200: json('Thông số', z.object({ items: z.array(SpecField) })) },
  });
  path({
    method: 'post',
    path: '/spec-fields',
    summary: 'Tạo thông số; bỏ `code` thì sinh từ tên',
    request: { body: body(SpecFieldBody) },
    responses: {
      201: json('Thông số vừa tạo', SpecField),
      409: problemResponse('`name_taken` (`errors.name`) hoặc `code_taken` (`errors.code`)'),
      422: problemResponse('`errors.unit` (không phải number), `errors.options` (không phải select/multiselect), `errors["options.<i>"]` trùng'),
    },
  });
  path({
    method: 'put',
    path: '/spec-fields/:id',
    summary: 'Sửa thông số (không đổi `code`, `input`); lựa chọn cũ vắng mặt là xoá, phát `catalog.spec_option_deleted`',
    request: { params: IdParams, body: body(UpdateSpecFieldBody) },
    responses: {
      200: json('Thông số sau khi sửa', SpecField),
      409: problemResponse('`version_conflict`, `name_taken`, hoặc `in_use` (xoá lựa chọn đang dùng, `errors["options.<i>"]`)'),
      ...missing('thông số'),
      422: problemResponse('`errors.unit` (đổi đơn vị khi đã có giá trị), `errors["options.<i>"]`'),
    },
  });
  path({
    method: 'delete',
    path: '/spec-fields/:id',
    summary: 'Xoá thông số không nhóm nào dùng, không sản phẩm nào có giá trị; phát `catalog.spec_field_deleted`',
    request: { params: IdParams, query: VersionQuery },
    responses: {
      204: noContent,
      409: problemResponse('`in_use` kèm `groupCount`, `productCount`, `groups: { id, name }[]` (≤ 20), hoặc `version_conflict`'),
      ...missing('thông số'),
      ...invalid,
    },
  });
  path({
    method: 'get',
    path: '/settings',
    summary: 'Cài đặt sản phẩm của công ty: mẫu SKU, gợi ý mặc định',
    responses: { 200: json('Cài đặt', ProductSettings) },
  });
  path({
    method: 'put',
    path: '/settings',
    summary: 'Sửa cài đặt sản phẩm; mẫu mới chỉ áp cho SKU sinh sau',
    request: { body: body(SettingsBody) },
    responses: { 200: json('Cài đặt sau khi sửa', ProductSettings), 409: problemResponse('`version_conflict` (kèm `current`)'), ...invalid },
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
    summary: 'Tạo sản phẩm; SKU sinh theo mẫu SKU của công ty, theo thứ tự biến thể; trục, giá trị mới tạo cùng lúc',
    request: { body: body(CreateProductBody) },
    responses: { 201: json('Sản phẩm vừa tạo', ProductDetail), 409: problemResponse('Tên đã dùng (`name_taken`)'), ...invalid },
  });
  path({
    method: 'put',
    path: '/products/:id',
    summary: 'Sửa tên, mô tả, ảnh, thuộc tính gắn ảnh, xuất xứ, thương hiệu, nhóm hàng (SKU giữ nguyên); không đổi biến thể',
    description:
      '`imageAttributeId` phải là một trục phân loại của sản phẩm; đổi sang thuộc tính khác hoặc `null` thì gỡ mọi ảnh phân loại ' +
      'cũ (không xoá tệp). `originCountry` cắt khoảng trắng, viết hoa; `originCountry`, `brand` rỗng lưu null.',
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
    method: 'put',
    path: '/products/:id/attribute-value-images/:attributeValueId',
    summary: 'Đặt hoặc thay ảnh phân loại của một giá trị thuộc tính gắn ảnh',
    description:
      'Không nhận `version`, không tăng `version` sản phẩm; gửi lại đúng tệp đang có thì không ghi. Ảnh cũ gỡ ra không xoá tệp. ' +
      'Mọi SKU mang giá trị này dùng chung ảnh (`variants[].image`).',
    request: { params: VariantImageParams, body: body(SetVariantImageBody) },
    responses: {
      200: json('Sản phẩm sau khi đặt ảnh', ProductDetail),
      ...missing('sản phẩm'),
      422: problemResponse(
        '`validation_failed`: `errors.attributeValueId` (chưa chọn thuộc tính gắn ảnh, giá trị không thuộc thuộc tính gắn ảnh), `errors.image` (tệp)',
      ),
    },
  });
  path({
    method: 'delete',
    path: '/products/:id/attribute-value-images/:attributeValueId',
    summary: 'Gỡ ảnh phân loại của một giá trị (không xoá tệp)',
    description: 'Giá trị chưa có ảnh vẫn 200 bản hiện tại.',
    request: { params: VariantImageParams },
    responses: { 200: json('Sản phẩm sau khi gỡ ảnh', ProductDetail), ...missing('sản phẩm') },
  });
  path({
    method: 'get',
    path: '/variants/bulk-edit',
    summary: 'Lấy SKU để sửa hàng loạt, kèm giá trị gợi ý (không tự lưu)',
    description:
      'Chỉ SKU chưa lưu trữ của sản phẩm chưa lưu trữ. `incomplete=true`: còn ít nhất một ô giá muốn bán, cân nặng, dài, rộng, cao bỏ trống. ' +
      '`suggestions` chỉ có cho ô đang trống: giá muốn bán = giá nhập × hệ số lãi (nhóm hàng, trống thì cài đặt công ty) (làm tròn lên theo bước của danh mục), ' +
      'không có thì chép từ SKU anh em; ngưỡng tồn theo tốc độ bán 30 ngày hoặc ngưỡng mặc định (nhóm, trống thì công ty); cân nặng, kích thước, giá chuẩn chép từ SKU anh em. ' +
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
