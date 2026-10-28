import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { problemResponse } from '../../../../shared/http/openapi.ts';
import {
  AuthorizeUrl,
  CallbackBody,
  CategoryAttributeList,
  ChannelListing,
  DelistBody,
  ListingList,
  ListingParams,
  ListingSyncResult,
  PushBody,
  PushResults,
  CategoryMap,
  CategoryMapBody,
  CategoryMapList,
  CategoryMapParams,
  CategoryParams,
  CategorySearchQuery,
  DisconnectBody,
  PlatformCategoryList,
  PlatformParams,
  Shop,
  ShopCallbackResult,
  ShopDetail,
  ShopList,
  ShopParams,
  TokenBody,
} from './schemas.ts';

const json = <T>(schema: T) => ({ content: { 'application/json': { schema } } });
const bearer = [{ bearerAuth: [] }];
const auth = {
  401: problemResponse('`unauthorized`'),
  403: problemResponse('`company_not_selected`, `company_locked`, `account_locked`, `module_disabled`, `forbidden`'),
};
const marketplace = {
  409: problemResponse(
    '`shop_connected_elsewhere`; `marketplace_rejected` kèm `platformCode`, `platformMessage`; `version_conflict`',
  ),
  422: problemResponse('`validation_failed`, `marketplace_unsupported`'),
  503: problemResponse('`marketplace_unavailable`: sàn lỗi tạm, thử lại'),
};
const connected = {
  200: { description: 'Nối lại gian hàng đã có', ...json(ShopCallbackResult) },
  201: { description: 'Gian hàng mới, trạng thái `connecting`', ...json(ShopCallbackResult) },
};

/** Đường dẫn Swagger của module `channel`, viết tương đối với /api/v1/channel. */
export function registerChannelOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/shops',
    summary: 'Gian hàng của công ty (Documents/21 §18.1)',
    description: 'Cần `channel.shop.view`. Cũ trước.',
    security: bearer,
    responses: { 200: { description: 'Danh sách gian hàng', ...json(ShopList) }, ...auth },
  });
  registry.registerPath({
    method: 'get',
    path: '/shops/:id',
    summary: 'Chi tiết gian hàng, kèm lịch sử trạng thái',
    description: 'Cần `channel.shop.view`.',
    security: bearer,
    request: { params: ShopParams },
    responses: {
      200: { description: 'Gian hàng', ...json(ShopDetail) },
      ...auth,
      404: problemResponse('`not_found`'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/shops/:platform/authorize-url',
    summary: 'URL uỷ quyền của sàn (§18.4)',
    description: 'Cần `channel.shop.connect`. `state` trong URL hết hạn sau 10 phút, chỉ dùng được cho người bấm.',
    security: bearer,
    request: { params: PlatformParams },
    responses: { 200: { description: 'URL uỷ quyền', ...json(AuthorizeUrl) }, ...auth, 422: marketplace[422] },
  });
  registry.registerPath({
    method: 'post',
    path: '/shops/:platform/callback',
    summary: 'Đổi `code` của sàn lấy token, tạo hoặc nối lại gian hàng (§18.4)',
    description:
      'Cần `channel.shop.connect`. `state` sai hoặc quá 10 phút: 422 `oauth_state_invalid`. Gian hàng đã có thì dùng lại bản ghi.',
    security: bearer,
    request: { params: PlatformParams, body: json(CallbackBody) },
    responses: {
      ...connected,
      ...auth,
      ...marketplace,
      422: problemResponse('`validation_failed`, `oauth_state_invalid`, `marketplace_unsupported`'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/shops/:platform/token',
    summary: 'Nối gian hàng bằng token lấy trên console của sàn',
    description:
      'Cần `channel.shop.connect`. Dùng cho shop thử (không đi OAuth được). Có `refreshToken` thì làm mới một lần để biết hạn token.',
    security: bearer,
    request: { params: PlatformParams, body: json(TokenBody) },
    responses: { ...connected, ...auth, ...marketplace },
  });
  registry.registerPath({
    method: 'post',
    path: '/shops/:id/disconnect',
    summary: 'Ngắt gian hàng (§18.1)',
    description:
      'Cần `channel.shop.disconnect`. Xoá token, listing còn trên sàn chuyển `delisted`. `zeroStock: true` chưa hỗ trợ (422).',
    security: bearer,
    request: { params: ShopParams, body: json(DisconnectBody) },
    responses: {
      200: { description: 'Gian hàng đã ngắt', ...json(Shop) },
      ...auth,
      404: problemResponse('`not_found`'),
      409: problemResponse('`invalid_transition` (đã ngắt), `version_conflict` kèm `current`'),
      422: problemResponse('`validation_failed`, `marketplace_unsupported`'),
    },
  });

  const onShop = {
    ...auth,
    404: problemResponse('`not_found`: gian hàng không có hoặc của công ty khác'),
    409: problemResponse('`shop_not_connected`; `marketplace_rejected` kèm `platformCode`, `platformMessage`'),
    422: problemResponse('`validation_failed`, `marketplace_unsupported`'),
    503: problemResponse('`marketplace_unavailable`: sàn lỗi tạm, thử lại'),
  };
  registry.registerPath({
    method: 'get',
    path: '/shops/:id/categories',
    summary: 'Tìm danh mục lá của sàn (#104)',
    description: 'Cần `channel.listing.manage`. Gọi sàn bằng token của gian hàng; tối đa 50 kết quả.',
    security: bearer,
    request: { params: ShopParams, query: CategorySearchQuery },
    responses: { 200: { description: 'Danh mục lá', ...json(PlatformCategoryList) }, ...onShop },
  });
  registry.registerPath({
    method: 'get',
    path: '/shops/:id/categories/:externalId/attributes',
    summary: 'Thuộc tính bắt buộc của một danh mục sàn',
    description: 'Cần `channel.listing.manage`. Tên, mô tả, giá, kích thước gói BE tự điền từ catalog nên không có ở đây.',
    security: bearer,
    request: { params: CategoryParams },
    responses: { 200: { description: 'Thuộc tính bắt buộc', ...json(CategoryAttributeList) }, ...onShop },
  });
  registry.registerPath({
    method: 'get',
    path: '/shops/:id/category-maps',
    summary: 'Danh mục Commerio đã ghép với danh mục sàn',
    description: 'Cần `channel.shop.view`.',
    security: bearer,
    request: { params: ShopParams },
    responses: { 200: { description: 'Các ghép danh mục', ...json(CategoryMapList) }, ...onShop },
  });
  registry.registerPath({
    method: 'put',
    path: '/shops/:id/category-maps/:categoryId',
    summary: 'Ghép danh mục Commerio với danh mục lá của sàn (#104)',
    description:
      'Cần `channel.listing.manage`. Thuộc tính bắt buộc của danh mục sàn phải đủ, đúng lựa chọn: thiếu thì 422 `errors["attributes.<tên>"]`. `version: null` là ghép mới.',
    security: bearer,
    request: { params: CategoryMapParams, body: json(CategoryMapBody) },
    responses: {
      200: { description: 'Ghép danh mục', ...json(CategoryMap) },
      ...onShop,
      409: problemResponse('`shop_not_connected`, `version_conflict` kèm `current`, `marketplace_rejected`'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/shops/:id/listings',
    summary: 'Biến thể đang bán kèm giá chuẩn và listing trên gian hàng (§18.3)',
    description: 'Cần `channel.shop.view`. `listing: null` là chưa lên sàn (`not_listed`).',
    security: bearer,
    request: { params: ShopParams },
    responses: { 200: { description: 'Danh sách', ...json(ListingList) }, ...auth, 404: problemResponse('`not_found`') },
  });
  registry.registerPath({
    method: 'post',
    path: '/shops/:id/listings/push',
    summary: 'Đẩy biến thể lên sàn (#104)',
    description:
      'Cần `channel.listing.manage`. Mỗi biến thể một sản phẩm trên sàn; kết quả theo từng biến thể, dòng lỗi không làm hỏng dòng khác. Thành công: `pushing → under_review`. Lỗi sàn: `push_failed` kèm `pushError`. Biến thể đã có trên sàn: `already_listed` (giá, tồn đồng bộ riêng).',
    security: bearer,
    request: { params: ShopParams, body: json(PushBody) },
    responses: { 200: { description: 'Kết quả theo biến thể', ...json(PushResults) }, ...onShop },
  });
  registry.registerPath({
    method: 'post',
    path: '/shops/:id/listings/sync',
    summary: 'Đồng bộ listing với sàn (#104)',
    description:
      'Cần `channel.shop.sync`. Đọc trạng thái sàn của listing mình (duyệt, từ chối, khoá, gỡ khoá); listing kẹt `pushing` quá 30 phút chuyển `push_failed`; đẩy giá chuẩn và số khả dụng của listing `stockSync`/`priceSync` khác `synced`, theo lô 20, lỗi ghi theo từng SKU. #102 sẽ chạy định kỳ.',
    security: bearer,
    request: { params: ShopParams },
    responses: { 200: { description: 'Tóm tắt', ...json(ListingSyncResult) }, ...onShop },
  });
  registry.registerPath({
    method: 'post',
    path: '/shops/:id/listings/:variantId/delist',
    summary: 'Gỡ listing khỏi sàn (§18.3)',
    description: 'Cần `channel.listing.manage`. Tắt sản phẩm trên sàn rồi chuyển `delisted`, giữ ghép để đẩy lại.',
    security: bearer,
    request: { params: ListingParams, body: json(DelistBody) },
    responses: {
      200: { description: 'Listing sau khi gỡ', ...json(ChannelListing) },
      ...onShop,
      404: problemResponse('`not_found`: gian hàng hoặc biến thể chưa có listing'),
      409: problemResponse('`shop_not_connected`, `invalid_transition` (đang đẩy, đã gỡ), `version_conflict` kèm `current`'),
    },
  });
}
