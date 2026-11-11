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
  MappingBody,
  MappingParams,
  MatchBody,
  RemoteSkuList,
  RemoteSkusQuery,
  OrderPullResult,
  PushBody,
  PushResults,
  SetupBody,
  ShopSetupPreview,
  ShopSetupResult,
  OpeningStocktakeResult,
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
  ShopDisconnectConflict,
  ShopParams,
  ShopPlatformList,
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
    '`shop_connected_elsewhere` (một gian hàng của lần nối đang gắn công ty khác: không gian hàng nào được nối); `marketplace_rejected` kèm `platformCode`, `platformMessage` (`no_shop`: lần uỷ quyền không ra gian hàng nào; `missing_parameter`: thiếu tham số adapter cần); `version_conflict`',
  ),
  422: problemResponse('`validation_failed`, `marketplace_unsupported`'),
  503: problemResponse('`marketplace_unavailable`: sàn lỗi tạm, thử lại'),
};
const connected = {
  200: { description: 'Chỉ nối lại gian hàng đã có', ...json(ShopCallbackResult) },
  201: { description: 'Có ít nhất một gian hàng mới (trạng thái `connecting`)', ...json(ShopCallbackResult) },
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
    path: '/shops/platforms',
    summary: 'Sàn và cách nối trên môi trường này (§18.1, §18.7.3)',
    description:
      'Cần `channel.shop.view`. Adapter đăng ký theo thứ tự đăng ký, rồi sàn chưa có adapter (`shopee`, `tiktok` tới commerio-backend#217). Adapter đủ cấu hình cho ít nhất một cách nối: `connectable: true`, `reason: null`. Adapter thiếu cấu hình trên môi trường này hoặc sàn chưa có adapter: `connectable: false`, `methods: []`, `reason` cho người đọc. Không trả `mock`, không lộ khoá, URL nội bộ, tên biến môi trường. Danh sách có thể không có mục nào `connectable: true`.',
    security: bearer,
    responses: { 200: { description: 'Danh sách sàn', ...json(ShopPlatformList) }, ...auth },
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
    summary: 'Callback OAuth: adapter đổi tham số sàn trả lấy token, tạo hoặc nối lại các gian hàng (§18.4, §18.6.3)',
    description:
      'Cần `channel.shop.connect`. Body `{ state, params }`, `params` là mọi query trên URL callback trừ `state`; body cũ `{ code, state }` vẫn nhận (coi như `params = { code }`), gửi cả hai thì `params` thắng. Thiếu, rỗng, sai chữ ký, quá 10 phút, khác người bấm hoặc khác sàn `state`: 422 `oauth_state_invalid`. `state` hợp lệ nhưng công ty trong `state` khác công ty trong token: 409 `company_mismatch` kèm `expected`, `actual` (`{ id, name }`, công ty trong `state` và trong token), không đổi `code`, không ghi gian hàng nào (§18.7.4). Một lần uỷ quyền có thể ra nhiều gian hàng: nối tất cả hoặc không; `shops` đủ cả, `shop`/`created`/`reconnect` là của phần tử đầu. Gian hàng đã có thì dùng lại bản ghi. Mỗi phần tử `shops` có `previousStatus` (null khi tạo mới), `remoteProductCount` (số sản phẩm trên sàn) và `remoteSkuCount` (số phân loại, tức SKU của sàn; `null` khi sàn không trả tổng) (§18.7.4); cả hai `null` khi sàn lỗi hoặc quá 10 giây, việc nối vẫn xong.',
    security: bearer,
    request: { params: PlatformParams, body: json(CallbackBody) },
    responses: {
      ...connected,
      ...auth,
      ...marketplace,
      409: problemResponse(
        '`company_mismatch` kèm `expected`, `actual` (`{ id, name }`); `shop_connected_elsewhere`; `marketplace_rejected` kèm `platformCode`, `platformMessage`; `version_conflict`',
      ),
      422: problemResponse('`validation_failed`, `oauth_state_invalid`, `marketplace_unsupported`'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/shops/:platform/token',
    summary: 'Nối gian hàng bằng token lấy trên console của sàn',
    description:
      'Cần `channel.shop.connect`. Dùng cho shop thử (không đi OAuth được). Trả như `callback` (có `shops`; một token có thể ra nhiều gian hàng). Lazada: có `refreshToken` thì làm mới một lần để biết hạn token.',
    security: bearer,
    request: { params: PlatformParams, body: json(TokenBody) },
    responses: { ...connected, ...auth, ...marketplace },
  });
  registry.registerPath({
    method: 'post',
    path: '/shops/:id/disconnect',
    summary: 'Ngắt gian hàng (§18.1, §18.6.1)',
    description:
      'Cần `channel.shop.disconnect`. Kiểm theo thứ tự, dừng ở lỗi đầu: 404 `not_found` → 409 `invalid_transition` → 409 `version_conflict` → 409 `shop_has_open_orders` (còn đơn chưa `completed` hoặc `cancelled`, kèm `openOrders` và `orders` tối đa 20 đơn cũ nhất; kiểm dưới khoá dòng gian hàng). Qua hết mới đẩy tồn 0 khi `zeroStock: true`; không gọi được sàn thì 422 `zero_stock_unavailable`, chưa ngắt. Ngắt xoá token, listing còn trên sàn chuyển `delisted`.',
    security: bearer,
    request: { params: ShopParams, body: json(DisconnectBody) },
    responses: {
      200: { description: 'Gian hàng đã ngắt', ...json(Shop) },
      ...auth,
      404: problemResponse('`not_found`'),
      409: {
        description: '`invalid_transition` (đã ngắt) kèm `current` là trạng thái, `version_conflict` kèm `current` là gian hàng, `shop_has_open_orders` kèm `openOrders`, `orders` (§18.7.8)',
        content: { 'application/problem+json': { schema: ShopDisconnectConflict } },
      },
      422: problemResponse('`validation_failed`, `zero_stock_unavailable`'),
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
      "Cần `channel.listing.manage`. Chỉ kiểm và xếp việc nền `channel.listing_push`, không gọi sàn, trả ngay (21 §18.6.4). Kết quả theo từng biến thể: dòng hợp lệ chuyển `pushing` (listing mới, hoặc đẩy lại từ `push_failed`, `rejected`, `platform_hold`; listing đã gỡ thì tạo bản ghi mới trỏ bản cũ); dòng bị chặn có `code`. Việc nền gọi sàn tối đa 5 lần: `under_review`/`live`, hoặc `push_failed` kèm `pushError`. Lỗi cả request theo thứ tự (21 §18.6.11): 409 `shop_not_active` (kèm `current`), `shop_awaiting_stocktake` (§18.6.2), `shop_awaiting_allocation` (lượt kéo đơn còn mở chưa xong hoặc phiếu đầu kỳ đã ghi sổ mà chưa phân hàng xong; problem body thêm `waitingFor: 'open_orders' | 'allocation'`), `shop_not_connected`; không dòng nào đổi, không xếp việc.",
    security: bearer,
    request: { params: ShopParams, body: json(PushBody) },
    responses: {
      200: { description: 'Kết quả theo biến thể', ...json(PushResults) },
      ...onShop,
      409: problemResponse('`shop_not_active`, `shop_awaiting_stocktake`, `shop_awaiting_allocation` kèm `waitingFor`, `shop_not_connected`; `marketplace_rejected` kèm `platformCode`, `platformMessage`'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/shops/:id/remote-skus',
    summary: 'SKU đang có trên sàn kèm ghép hiện hành (#220)',
    description:
      'Cần `channel.listing.match` (CEO, Admin, Sale). Đọc thẳng danh sách SKU của gian hàng từ sàn (chưa lưu bản sao), bỏ SKU đã xoá. `unmatched=true`: chỉ SKU chưa ghép (kể cả đang chờ CEO duyệt ghép sang "không quản tồn"). Sàn chưa đọc được danh sách SKU: 422 `marketplace_unsupported`.',
    security: bearer,
    request: { params: ShopParams, query: RemoteSkusQuery },
    responses: { 200: { description: 'SKU trên sàn', ...json(RemoteSkuList) }, ...onShop },
  });
  registry.registerPath({
    method: 'post',
    path: '/shops/:id/listings/match',
    summary: 'Ghép SKU sàn với biến thể (#220, 21 §18.6.5)',
    description:
      'Cần `channel.listing.match` (CEO, Admin, Sale). SKU sàn chưa ghép: tạo listing `live`, không đẩy lại (200). `variantId: null` là "không quản tồn". Ghép sang "không quản tồn", hoặc đổi ghép đã có đơn (gian hàng đã nhận đơn có món mang SKU người bán này): người không được tự duyệt (không phải CEO, công ty nhiều người) thì lưu `pendingMapping`, trả 202; CEO làm thì áp luôn, lịch sử ghi `selfApproved`. Đổi ghép áp cho đơn kéo về sau; đơn đã nhận giữ ghép cũ. Lỗi theo thứ tự: 404 → 409 `shop_not_active` (kèm `current`) → 409 `mapping_pending` (kèm `current`) → 409 `invalid_transition` (listing đang đẩy) → 422 `errors.variantId` (không thuộc công ty, lưu trữ, đã ghép SKU sàn khác của gian hàng) → 422 `errors.externalSkuId` (không còn trên sàn, chưa có SKU người bán; chỉ đọc sàn khi SKU chưa có listing) → 409 `version_conflict` (request khác vừa ghép SKU này).',
    security: bearer,
    request: { params: ShopParams, body: json(MatchBody) },
    responses: {
      200: { description: 'Đã áp ghép', ...json(ChannelListing) },
      202: { description: 'Chờ CEO duyệt: listing có `pendingMapping`', ...json(ChannelListing) },
      ...onShop,
      409: problemResponse('`shop_not_active`, `mapping_pending`, `invalid_transition`, `version_conflict`, `shop_not_connected`; `marketplace_rejected` kèm `platformCode`, `platformMessage`'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/shops/:id/listings/:listingId/mapping/:action',
    summary: 'CEO duyệt hoặc từ chối ghép chờ (#220, 21 §18.6.5)',
    description:
      'Cần `channel.listing.manage` và vai trò CEO (người khác: 403 `forbidden`). `approve`: áp ghép mới (kiểm lại biến thể, 422 `errors.variantId`); đơn mở đã giữ hàng theo ghép cũ giữ nguyên, chỉ đơn về sau theo ghép mới. `reject`: bắt buộc `reason` (422 `errors.reason`), bỏ ghép chờ; listing tạo ra chỉ để chờ duyệt "không quản tồn" thì xoá, body là listing lúc xoá. Thứ tự: 404 → 409 `invalid_transition` (không có `pendingMapping`, listing đã gỡ hoặc đang đẩy) → 409 `version_conflict` (kèm `current`); hai lần duyệt đua về cùng biến thể: lần sau 422 `errors.variantId`.',
    security: bearer,
    request: { params: MappingParams, body: json(MappingBody) },
    responses: {
      200: { description: 'Listing sau khi duyệt hoặc từ chối', ...json(ChannelListing) },
      ...auth,
      404: problemResponse('`not_found`: gian hàng hoặc listing'),
      409: problemResponse('`invalid_transition`, `version_conflict` kèm `current`'),
      422: problemResponse('`validation_failed` (`errors.reason`, `errors.variantId`)'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/shops/:id/setup',
    summary: 'Gợi ý ghép listing có sẵn khi thiết lập lần đầu (§18.2)',
    description:
      'Cần `channel.shop.connect`. Mọi SKU người bán trên sàn (sàn chưa đọc được cả gian hàng thì chỉ SKU trùng SKU Commerio), mỗi dòng `match` `sku` / `name` (tên giống từ 0.4 theo pg_trgm, kèm `score`) / `none`; biến thể lưu trữ hay đã có listing ở gian hàng không được gợi ý; SKU sàn trùng tiêu đề với SKU khác (một sản phẩm nhiều SKU) hoặc không có SKU người bán không được gợi ý theo tên (21 §18.7.5). `proposedCutoffAt`, `firstShopOfCompany` (§18.6.2). Gian hàng không ở `connecting`: 409 `invalid_transition`. Gian hàng quá 10000 sản phẩm (Lazada): 409 `marketplace_rejected` `too_many_products`.',
    security: bearer,
    request: { params: ShopParams },
    responses: { 200: { description: 'Gợi ý', ...json(ShopSetupPreview) }, ...onShop },
  });
  registry.registerPath({
    method: 'post',
    path: '/shops/:id/setup',
    summary: 'Hoàn tất thiết lập lần đầu (§18.2)',
    description:
      'Cần `channel.shop.connect`. Tạo listing `live` theo `decisions` (hoặc `externalSkuIds` cũ), mốc kéo đơn = lúc gọi (`orderCutoffAt` trong body bị bỏ qua, §18.7.6), gian hàng `connecting → active`, xếp lượt kéo đơn còn mở; lúc này chỉ đẩy giá, tồn đẩy sau lượt đó (`Shop.setup`). `stocktake`: lập phiếu kiểm kê đầu kỳ, gian hàng ở chế độ chờ kiểm kê (`openingStocktake`). Sai: 422 `errors.openingStock` (gian hàng đầu tiên của công ty gửi `push`; công ty đang chờ phiếu đầu kỳ khác), `errors.decisions` (gửi cả `externalSkuIds`), `errors["decisions.<i>"]` (SKU không có trong gợi ý, SKU sàn chưa có SKU người bán, lặp, biến thể không thuộc công ty, lưu trữ, đã ghép ở gian hàng; tối đa 10000 dòng). Kiểm lại dưới khoá của công ty nên hai lần thiết lập cùng công ty chạy lần lượt, `errors.externalSkuIds`, `errors.returnWindowDays` (sàn `capabilities.returnWindow = days`: số nguyên 1–60; không gửi thì giữ giá trị đang có tới khi FE gửi trường này; sàn `platform_status` bỏ qua, lưu null).',
    security: bearer,
    request: { params: ShopParams, body: json(SetupBody) },
    responses: {
      200: { description: 'Kết quả', ...json(ShopSetupResult) },
      ...onShop,
      409: problemResponse('`invalid_transition`, `shop_not_connected`, `version_conflict`'),
      501: problemResponse(
        '`not_implemented` kèm `issue`, `owner`: `stocktake` khi chưa có cổng lập phiếu kiểm kê (commerio-backend#245, Bình); không ghi gì, gian hàng vẫn `connecting` (21 §18.7.9)',
      ),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/shops/:id/opening-stocktake',
    summary: 'Lập lại phiếu kiểm kê đầu kỳ',
    description:
      "Chỉ hợp lệ khi gian hàng `active`, `openingStocktake` khác null, và phiếu hiện tại ở `rejected`, `cancelled` hoặc không còn (`openingStocktakeStatusOf` không trả id này). BE làm dưới khoá dòng gian hàng: đọc trạng thái phiếu, gọi `createOpeningStocktake(shopId, { actorId })`, thay `openingStocktake` bằng phiếu mới (`status = 'draft'`), ghi một dòng nhật ký. `orderCutoffAt` giữ mốc tạm; phiếu mới ghi sổ thì đặt lại theo thời điểm đếm của phiếu mới (18.6.2). Phiếu mới cũng mỗi SKU đang bán một dòng, không giới hạn số dòng (mục 11.3).",
    security: bearer,
    request: { params: ShopParams },
    responses: {
      200: { description: '`{ shop, stocktakeNumber }`', ...json(OpeningStocktakeResult) },
      ...onShop,
      409: problemResponse(
        'Gian hàng không `active`: 409 `shop_not_active`. `openingStocktake = null` (chưa từng chờ kiểm kê, hoặc phiếu đã ghi sổ): 409 `shop_not_awaiting_stocktake`. Phiếu hiện tại còn `draft` hoặc `pending`: 409 `opening_stocktake_open`, problem body thêm `number`, `status`. Hai lần gọi đua: lần sau thấy phiếu mới ở `draft` nên nhận 409 `opening_stocktake_open`.',
      ),
    },
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
    path: '/shops/:id/orders/pull',
    summary: 'Kéo đơn sàn ngay (#105)',
    description:
      'Cần `channel.shop.sync`. Kéo đơn có cập nhật từ mốc kéo đơn của gian hàng (lần đầu: mốc chọn lúc thiết lập) lùi 2 phút; đơn đặt trước mốc thiết lập bỏ qua. Việc nền tự chạy mỗi 5 phút. Sàn lỗi giữa chừng: các đơn trước đó đã lưu, lần sau làm tiếp.',
    security: bearer,
    request: { params: ShopParams },
    responses: { 200: { description: 'Tóm tắt', ...json(OrderPullResult) }, ...onShop },
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
