import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { problemResponse } from '../../../../shared/http/openapi.ts';
import {
  AuthorizeUrl,
  AuthorizeUrlQuery,
  CallbackBody,
  CategorySyncResult,
  LeafDetailQuery,
  CascadeLevelSchema,
  CascadeQuery,
  CategorySuggestionsQuery,
  CategorySuggestionsView,
  ShopWarehousesView,
  CategorySyncBody,
  ApplyCategoryBody,
  AxisMappingBody,
  AxisMappingItemSchema,
  AxisMappingList,
  AxisMappingParams,
  ApplyCategoryResult,
  ProductSpecBody,
  ProductSpecParams,
  ProductSpecQuery,
  ProductSpecView,
  AttributeCatalogList,
  AttributeCatalogQuery,
  PlatformParams,
  SpecMappingBody,
  SpecMappingList,
  SpecMappingParams,
  SpecMappingSchema,
  PlatformCategoriesQuery,
  PlatformCategoryPage,
  PlatformLeafDetail,
  PlatformLeafParams,
  ChannelListing,
  DelistBody,
  UpdateContentBody,
  UpdateContentParams,
  TakeOverContentBody,
  TakeOverContentParams,
  ListingList,
  ProductListingsParams,
  ProductListingListWithSeparate,
  RegroupParams,
  RegroupQueued,
  ListingParams,
  ListingSyncResult,
  MappingBody,
  MappingParams,
  AcknowledgeTitleBody,
  AcknowledgeTitleParams,
  OutsideChangeBody,
  OutsideChangeParams,
  MatchBody,
  MatchPreview,
  MatchPreviewQuery,
  RemoteSkuList,
  RemoteSkusQuery,
  OrderPullResult,
  PushBody,
  MatchBulkBody,
  MatchBulkResult,
  CreateVariantBody,
  CreateVariantParams,
  CreateVariantResult,
  PriceQuoteBody,
  PriceQuoteList,
  PriceQuoteParams,
  PushResults,
  SetupBody,
  ShopSetupPreview,
  ShopSetupResult,
  OpeningStocktakeResult,
  DisconnectBody,
  ShopDeleteBody,
  ShopDeleteConflict,
  ShopDeleteResult,
  UpdateShopBody,
  Shop,
  ShopCallbackResult,
  ShopDetail,
  ShopList,
  ShopDisconnectConflict,
  ShopParams,
  ShopPlatformList,
  TokenBody,
  ConfirmPriceBody,
  ListingIdParams,
  ManualPriceBody,
  ManualPriceParams,
  PendingPricePage,
  PendingPricesQuery,
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
      'Cần `channel.shop.view`. Adapter đăng ký theo thứ tự đăng ký, rồi sàn trong danh sách chưa có adapter. Adapter đủ cấu hình cho ít nhất một cách nối: `connectable: true`, `reason: null`. Adapter thiếu cấu hình trên môi trường này hoặc sàn chưa có adapter: `connectable: false`, `methods: []`, `reason` cho người đọc. Không trả `mock`, không lộ khoá, URL nội bộ, tên biến môi trường. Danh sách có thể không có mục nào `connectable: true`.',
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
    description:
      'Cần `channel.shop.connect`. `state` trong URL hết hạn sau 10 phút, chỉ dùng được cho người bấm. Query `shopId` (tuỳ chọn, nút Kết nối lại): `state` mang gian hàng đó, callback chỉ nối lại đúng gian hàng này (409 `shop_mismatch` khi sàn trả seller khác). Không gửi thì gian hàng nhận ra theo mã seller sàn trả về.',
    security: bearer,
    request: { params: PlatformParams, query: AuthorizeUrlQuery },
    responses: {
      200: { description: 'URL uỷ quyền', ...json(AuthorizeUrl) },
      ...auth,
      404: problemResponse('`not_found`: gian hàng không thuộc công ty hoặc thuộc sàn khác'),
      422: marketplace[422],
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/shops/:platform/callback',
    summary: 'Callback OAuth: adapter đổi tham số sàn trả lấy token, tạo hoặc nối lại các gian hàng (§18.4, §18.6.3)',
    description:
      'Cần `channel.shop.connect`. Body `{ state, params }`, `params` là mọi query trên URL callback trừ `state`; body cũ `{ code, state }` vẫn nhận (coi như `params = { code }`), gửi cả hai thì `params` thắng. Thiếu, rỗng, sai chữ ký, quá 10 phút, khác người bấm hoặc khác sàn `state`: 422 `oauth_state_invalid`. `state` hợp lệ nhưng công ty trong `state` khác công ty trong token: 409 `company_mismatch` kèm `expected`, `actual` (`{ id, name }`, công ty trong `state` và trong token), không đổi `code`, không ghi gian hàng nào (§18.7.4). `state` lấy bằng `authorize-url?shopId=` (Kết nối lại): gian hàng đó không còn thì 404 `not_found` (kiểm trước khi đổi `code`, và khoá lại lúc ghi: mất giữa chừng cũng 404, không tạo gian hàng mới); sàn trả không có seller của gian hàng đó thì 409 `shop_mismatch`, bỏ token vừa nhận, không ghi gian hàng nào (#398). Một lần uỷ quyền có thể ra nhiều gian hàng: nối tất cả hoặc không; `shops` đủ cả, `shop`/`created`/`reconnect` là của phần tử đầu. Gian hàng đã có thì dùng lại bản ghi. Mỗi phần tử `shops` có `previousStatus` (null khi tạo mới), `remoteProductCount` (số sản phẩm trên sàn) và `remoteSkuCount` (số phân loại, tức SKU của sàn; `null` khi sàn không trả tổng) (§18.7.4); cả hai `null` khi sàn lỗi hoặc quá 10 giây, việc nối vẫn xong.',
    security: bearer,
    request: { params: PlatformParams, body: json(CallbackBody) },
    responses: {
      ...connected,
      ...auth,
      ...marketplace,
      409: problemResponse(
        '`company_mismatch` kèm `expected`, `actual` (`{ id, name }`); `shop_mismatch` kèm `expected`, `actual` (`{ name, externalShopId }`, `actual.name` null khi seller chưa có trong công ty); `shop_connected_elsewhere`; `marketplace_rejected` kèm `platformCode`, `platformMessage`; `version_conflict`',
      ),
      404: problemResponse('`not_found`: gian hàng trong `state` không còn'),
      422: problemResponse('`validation_failed`, `oauth_state_invalid`, `marketplace_unsupported`'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/shops/:platform/token',
    summary: 'Nối gian hàng bằng token lấy trên console của sàn',
    description:
      'Cần `channel.shop.connect`. Dùng cho shop thử (không đi OAuth được). Trả như `callback` (có `shops`; một token có thể ra nhiều gian hàng). Sàn trả hạn token qua lần làm mới: có `refreshToken` thì làm mới một lần để biết hạn. `shopId` (Kết nối lại, #398) kiểm như `authorize-url` trước khi gọi sàn: sai dạng hay rỗng thì 422 `errors.shopId`, gian hàng không thuộc công ty hay khác sàn thì 404, đã ngắt vẫn nhận; token của seller khác thì 409 `shop_mismatch` như `callback`, không ghi gian hàng nào; gian hàng mất trước khi ghi thì 404.',
    security: bearer,
    request: { params: PlatformParams, body: json(TokenBody) },
    responses: {
      ...connected,
      ...auth,
      ...marketplace,
      409: problemResponse(
        '`shop_mismatch` kèm `expected`, `actual` (`{ name, externalShopId }`, `actual.name` null khi seller chưa có trong công ty); `shop_connected_elsewhere`; `marketplace_rejected` kèm `platformCode`, `platformMessage`; `version_conflict`',
      ),
      404: problemResponse('`not_found`: gian hàng trong `shopId` không thuộc công ty, khác sàn, hoặc không còn'),
    },
  });
  registry.registerPath({
    method: 'patch',
    path: '/shops/:id',
    summary: 'Sửa hạn trả hàng của gian hàng (§18.4, #362)',
    description:
      'Cần `channel.shop.connect`. Mọi trạng thái gian hàng. Thứ tự: 422 `validation_failed` (body: `returnWindowDays` số nguyên 1–60, `version`, không trường lạ) → 404 `not_found` → 409 `version_conflict` kèm `current` → 422 `errors.returnWindowDays` khi sàn `capabilities.returnWindow = platform_status`. Ghi nhật ký thao tác.',
    security: bearer,
    request: { params: ShopParams, body: json(UpdateShopBody) },
    responses: {
      200: { description: 'Gian hàng sau khi sửa', ...json(Shop) },
      ...auth,
      404: problemResponse('`not_found`'),
      409: problemResponse('`version_conflict` kèm `current` là gian hàng'),
      422: problemResponse('`validation_failed`'),
    },
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

  registry.registerPath({
    method: 'delete',
    path: '/shops/:id',
    summary: 'Xoá gian hàng đã ngắt (#398)',
    description:
      'Cần `channel.shop.disconnect` và vai trò CEO (403 trước 422). Body `confirm` phải đúng chuỗi `XOA`. Kiểm theo thứ tự, dừng ở lỗi đầu: 404 `not_found` → 409 `shop_not_disconnected` (chỉ xoá gian hàng `disconnected`) → 409 `version_conflict` → 409 `shop_has_finance_data` (còn sổ tiền, dòng hàng sổ, bảng kê, lần đối soát, đối soát theo đơn khác `none`, chứng từ hay dòng thanh toán của đơn; kèm `financeData`). Còn phiếu kiểm hàng hoàn nháp, chờ duyệt đã cộng chờ xử lý (kho đã quét): 409 `shop_has_open_inspection` kèm `documents`, ghi sổ phiếu rồi xoá lại. Việc nền của gian hàng giữ khoá quá 3 giây: 409 `shop_busy`. Xoá trong một giao dịch đơn, kiện (nhả hàng đang giữ), yêu cầu trả, kiện trả lạc, listing, lần tính giá, đơn gốc, SKU sàn, thư báo uỷ quyền, cấu hình phí, đối soát `none`, số liệu theo ngày, hộp thư; phiếu kho nháp, chờ duyệt xoá, phiếu đã ghi sổ giữ (`shop_id` null, thêm ghi chú). Không xoá lịch sử trạng thái, nhật ký thao tác, thẻ kho. Ghi một dòng nhật ký `delete` `channel.shops`.',
    security: bearer,
    request: { params: ShopParams, body: json(ShopDeleteBody) },
    responses: {
      200: { description: 'Số dòng đã xoá, đã tách theo nhóm', ...json(ShopDeleteResult) },
      ...auth,
      404: problemResponse('`not_found`: gian hàng không có, của công ty khác, hoặc id sai dạng'),
      409: {
        description:
          '`shop_not_disconnected`, `version_conflict` kèm `current` là gian hàng; `shop_has_finance_data` kèm `financeData`; `shop_has_open_inspection` kèm `documents`; `shop_busy`',
        content: { 'application/problem+json': { schema: ShopDeleteConflict } },
      },
      422: problemResponse('`validation_failed`: `errors.confirm` khi không gõ đúng `XOA`, `errors.version`'),
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
    path: '/platforms/:platform/categories',
    summary: 'Cây category của sàn (#400)',
    description:
      'Cần `channel.shop.view`. Đọc từ DB, không gọi sàn. `search` (≥ 2 ký tự): leaf `active` có đường dẫn gần đúng (bỏ dấu, `đ` = `d`), tối đa 50, gần nhất trước; `parentId`: con trực tiếp; không gửi gì: cấp gốc. `shopId` (#448): gian hàng của công ty cùng sàn thì leaf kèm `permission` của gian hàng đó (đọc `shop_category_permissions`, null là chưa kiểm hoặc sàn không có quyền theo gian hàng); không gửi thì không có trường `permission`.',
    security: bearer,
    request: { params: PlatformParams, query: PlatformCategoriesQuery },
    responses: {
      200: { description: 'Category', ...json(PlatformCategoryPage) },
      ...auth,
      404: problemResponse('`not_found`: `shopId` không thuộc công ty hoặc khác sàn'),
      422: problemResponse('`validation_failed`; `marketplace_unsupported`: sàn không có adapter'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/platforms/:platform/categories/sync',
    summary: 'Đồng bộ ngay cây category của sàn (#400)',
    description:
      'Cần `channel.shop.sync`. Xếp một lượt `channel.category_sync` (cùng việc chạy mỗi đêm) rồi trả 202; đã có lượt chờ thì `queued: false`. Category sàn bỏ thì `status = removed`, spec trỏ tới sang `categoryStatus = removed`. Sàn cần token để đọc cây thì mượn token gian hàng `active` nối sớm nhất trên sàn; không có thì lượt bỏ qua. Sàn trả cây thiếu quá ngưỡng (từ 100 node đang dùng, bỏ hơn 5%) thì lượt không ghi gì, log `error` kèm số node sắp bỏ và tổng node; quản trị nền tảng (`is_platform_admin`) gửi `allowShrink: true` để lượt đó vẫn ghi (khoá lượt chờ riêng, không gộp vào lượt thường).',
    security: bearer,
    request: { params: PlatformParams, body: { required: false, content: { 'application/json': { schema: CategorySyncBody } } } },
    responses: {
      202: { description: 'Đã xếp hoặc đã có lượt chờ', ...json(CategorySyncResult) },
      ...auth,
      403: problemResponse('`forbidden`: thiếu `channel.shop.sync`, hoặc gửi `allowShrink: true` mà không phải quản trị nền tảng'),
      422: problemResponse('`marketplace_unsupported`: sàn không có adapter hoặc chưa đọc được cây'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/platforms/:platform/categories/:externalId',
    summary: 'Chi tiết một leaf: attribute, luật bảng kích cỡ, sản phẩm đang dùng (#400)',
    description:
      'Cần `channel.shop.view`. Attribute đọc từ bảng; chưa có hoặc quá 7 ngày thì gọi sàn (sàn cần token thì dùng token gian hàng `shopId`, không gửi thì gian hàng `active` đầu tiên của công ty) rồi ghi bảng. Sàn lỗi hoặc không có gian hàng mà bảng còn bản cũ: trả bản cũ, `stale: true`.',
    security: bearer,
    request: { params: PlatformLeafParams, query: LeafDetailQuery },
    responses: {
      200: { description: 'Leaf', ...json(PlatformLeafDetail) },
      ...auth,
      404: problemResponse('`not_found`: gian hàng `shopId` không có, của công ty khác hoặc khác sàn'),
      409: problemResponse(
        '`shop_not_connected`: phải gọi sàn mà không có gian hàng `active`; `marketplace_rejected`, `marketplace_unauthorized` kèm `platformCode`, `platformMessage`',
      ),
      422: problemResponse('`validation_failed`; `category_not_leaf`; `marketplace_unsupported`'),
      503: problemResponse('`marketplace_unavailable`: sàn lỗi tạm và chưa có bản nào'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/platforms/:platform/categories/:externalId/cascade',
    summary: 'Giá trị cấp kế của attribute cascade (#400)',
    description:
      'Cần `channel.listing.manage`. Gọi sàn, không lưu. Cần token gian hàng: `shopId`, không gửi thì gian hàng `active` đầu tiên. `path` là các cấp đã chọn theo định dạng `path` của sàn; `leaf = true` là cấp cuối, spec lưu `path` tới cấp đó.',
    security: bearer,
    request: { params: PlatformLeafParams, query: CascadeQuery },
    responses: {
      200: { description: 'Cấp kế', ...json(CascadeLevelSchema) },
      ...auth,
      404: problemResponse('`not_found`: gian hàng `shopId` không có, của công ty khác hoặc khác sàn'),
      409: problemResponse('`shop_not_connected`: không có gian hàng `active` của sàn; `marketplace_rejected`, `marketplace_unauthorized`'),
      422: problemResponse('`validation_failed` (`errors.code`: không phải attribute cascade đã lưu của leaf); `marketplace_unsupported`: sàn không có cascade'),
      503: problemResponse('`marketplace_unavailable`'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/shops/:id/warehouses',
    summary: 'Kho của gian hàng trên sàn (#430)',
    description:
      'Cần `channel.shop.view`. Gọi sàn mỗi lần. MVP một kho: app chỉ quản kho mặc định (`managed`), kho khác người bán dùng việc riêng, app không đọc tồn, không đẩy tồn, không nhận món xuất từ đó. Không có ô chọn kho. Sàn chỉ có một kho bán thì `items: []`.',
    security: bearer,
    request: { params: ShopParams },
    responses: {
      200: { description: 'Danh sách kho', ...json(ShopWarehousesView) },
      ...auth,
      404: problemResponse('`not_found`: gian hàng không có hoặc của công ty khác'),
      409: problemResponse('`shop_not_connected`; `marketplace_rejected`, `marketplace_unauthorized`'),
      503: problemResponse('`marketplace_unavailable`'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/shops/:id/category-suggestions',
    summary: 'Gợi ý category của sàn cho một sản phẩm (#400)',
    description:
      'Cần `channel.listing.manage`. Gọi sàn bằng token gian hàng theo tên và ảnh đầu của sản phẩm: sàn trả tối đa 5 gợi ý theo thứ tự của sàn; sàn có quyền category theo gian hàng thì kèm `permission` và ghi vào `shop_category_permissions`, không thì `permission: null`. `path` lấy từ cây đã đồng bộ khi có, không thì đường dẫn sàn trả. Sàn `unavailable` thì gọi lại một lần. Chưa có cache: `cached` luôn false. `group` (category của sản phẩm cùng nhóm hàng) và `recent` (công ty dùng gần đây) đọc từ DB, luôn trả (#448). Không gọi được sàn thì 200 `items: []` kèm `suggestError` (`product_name_too_short` kèm `min`, `images_missing`, `marketplace_unavailable`), hai lỗi đầu không gọi sàn; adapter có thể gửi thêm mô tả sản phẩm.',
    security: bearer,
    request: { params: ShopParams, query: CategorySuggestionsQuery },
    responses: {
      200: { description: 'Gợi ý', ...json(CategorySuggestionsView) },
      ...auth,
      404: problemResponse('`not_found`: gian hàng hay sản phẩm không có hoặc của công ty khác'),
      409: problemResponse('`shop_not_connected` (gian hàng không `active`, kèm `current`); `marketplace_rejected`, `marketplace_unauthorized`'),
      422: problemResponse('`validation_failed` (`errors.productId`); `marketplace_unsupported`'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/products/:productId/specs/:platform',
    summary: 'Thông tin sàn của sản phẩm (category, attribute, ánh xạ trục) (#400)',
    description:
      'Cần `channel.shop.view`. `resolved`: giá trị từng attribute theo thứ tự ghi đè > thông số catalog qua ánh xạ > hồ sơ công ty > mặc định sàn (#509). `missing` tính trên `resolved` theo attribute hiện có của leaf. Chưa có spec: `spec: null`, `resolved: {}`, `missing: []`. `suggestedAxisMap`, `suggestedValueMap`, `variantCapabilities` (#448) tính cho leaf `?categoryId` (chưa lưu) hoặc leaf của spec; null khi không có leaf hay chưa có attribute của leaf.',
    security: bearer,
    request: { params: ProductSpecParams, query: ProductSpecQuery },
    responses: {
      200: { description: 'Spec', ...json(ProductSpecView) },
      ...auth,
      404: problemResponse('`not_found`: sản phẩm không có hoặc của công ty khác'),
      422: problemResponse('`marketplace_unsupported`; `validation_failed` kèm `errors.categoryId` (category không phải lá đang dùng được)'),
    },
  });
  registry.registerPath({
    method: 'put',
    path: '/products/:productId/specs/:platform',
    summary: 'Lưu thông tin sàn của sản phẩm (#400)',
    description:
      'Cần `channel.listing.manage`. Attribute của leaf chưa có hoặc quá 7 ngày thì lấy từ sàn trước khi kiểm (sàn cần token thì dùng gian hàng `active` đầu tiên). `attributes` là toàn bộ tập ghi đè (#509): khoá không gửi hoặc rỗng là không ghi đè; giá trị trùng giá trị catalog, hồ sơ công ty, mặc định sàn thì không lưu; ghi đè được mọi attribute không phải sales, kể cả thương hiệu, xuất xứ. Bắt buộc kiểm trên giá trị sau khi áp ghi đè. Ghi nhật ký.',
    security: bearer,
    request: { params: ProductSpecParams, body: { content: { 'application/json': { schema: ProductSpecBody } } } },
    responses: {
      200: { description: 'Spec đã lưu', ...json(ProductSpecView) },
      ...auth,
      404: problemResponse('`not_found`'),
      409: problemResponse('`version_conflict` kèm `current`; `shop_not_connected`: sàn cần token mà chưa có gian hàng `active` và chưa có bản attribute nào'),
      422: problemResponse('`validation_failed` kèm `errors` theo ô (`externalCategoryId`, `attributes.<code>`, `axisMap.<attributeId>` kể cả `__custom` ở sàn không nhận tên trục tự đặt, `valueMap.<id>`); `marketplace_unsupported`'),
      503: problemResponse('`marketplace_unavailable`: sàn lỗi khi chưa có bản attribute nào'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/platforms/:platform/axis-mappings',
    summary: 'Ánh xạ trục phân loại của công ty sang sales attribute của sàn (#448)',
    description:
      'Cần `catalog.product.view`. Mỗi thuộc tính phân loại của công ty một dòng: `codes` là ánh xạ của công ty theo `priority`, `defaultCodes` là mặc định của adapter theo `platformKind` (chỉ đọc). Không gọi sàn.',
    security: bearer,
    request: { params: PlatformParams },
    responses: {
      200: { description: 'Danh sách', ...json(AxisMappingList) },
      ...auth,
      422: problemResponse('`marketplace_unsupported`'),
    },
  });
  registry.registerPath({
    method: 'put',
    path: '/platforms/:platform/axis-mappings/:attributeId',
    summary: 'Đặt ánh xạ trục của một thuộc tính trên sàn (#448)',
    description:
      'Cần `catalog.group.manage`. Chỉ thuộc tính riêng của công ty. `codes` thay cả danh sách (thứ tự là `priority`, `[]` là bỏ). Mỗi mã phải là sales attribute đã gặp ở ít nhất một leaf của sàn. Ghi nhật ký.',
    security: bearer,
    request: { params: AxisMappingParams, body: { content: { 'application/json': { schema: AxisMappingBody } } } },
    responses: {
      200: { description: 'Dòng đã lưu', ...json(AxisMappingItemSchema) },
      ...auth,
      403: problemResponse('Thiếu quyền; `platform_managed`: thuộc tính chuẩn, ánh xạ do nền tảng giữ'),
      404: problemResponse('`not_found`: không phải thuộc tính của công ty'),
      422: problemResponse('`validation_failed` kèm `errors["codes.<i>.attributeCode"]` (trùng, không phải sales attribute đã gặp); `marketplace_unsupported`'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/platforms/:platform/spec-mappings',
    summary: 'Ánh xạ thông số của công ty sang attribute của sàn (#509)',
    description: 'Cần `catalog.product.view`. Mỗi thông số một dòng; `codes` đã lưu theo `priority`; `suggestions` tính lúc đọc, không lưu. Không gọi sàn.',
    security: bearer,
    request: { params: PlatformParams },
    responses: { 200: { description: 'Ánh xạ', ...json(SpecMappingList) }, ...auth, 422: problemResponse('`marketplace_unsupported`') },
  });
  registry.registerPath({
    method: 'put',
    path: '/platforms/:platform/spec-mappings/:fieldId',
    summary: 'Thay tập mã ánh xạ của một thông số trên một sàn (#509)',
    description:
      'Cần `catalog.group.manage`. Thứ tự mảng là `priority`, `[]` là bỏ. Bỏ một mã thì bỏ luôn ánh xạ lựa chọn của mã đó. Mã phải là attribute property đã gặp ở leaf nào đó của sàn; mỗi mã của sàn chỉ ánh xạ cho một thông số (tính cả mã của thông số chuẩn). Thông số chuẩn (`scope = platform`): gửi đúng tập mã hiện có, chỉ ánh xạ lựa chọn riêng của công ty được thay. Ghi nhật ký.',
    security: bearer,
    request: { params: SpecMappingParams, body: { content: { 'application/json': { schema: SpecMappingBody } } } },
    responses: {
      200: { description: 'Ánh xạ sau khi lưu', ...json(SpecMappingSchema) },
      ...auth,
      403: problemResponse('Thiếu quyền; `platform_managed`: thông số chuẩn mà đổi tập mã hay ánh xạ lựa chọn chuẩn'),
      404: problemResponse('`not_found`: thông số không có hoặc của công ty khác'),
      422: problemResponse('`validation_failed` kèm `errors["codes.<i>.attributeCode"]`, `errors["codes.<i>.options.<j>"]`; `marketplace_unsupported`'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/platforms/:platform/attribute-catalog',
    summary: 'Tìm attribute đã gặp của sàn để ánh xạ (#509)',
    description: 'Cần `catalog.product.view`. Gộp theo mã các attribute ở mọi leaf đã lấy (lựa chọn gộp, bỏ trùng), tối đa 50. Đọc DB, không gọi sàn.',
    security: bearer,
    request: { params: PlatformParams, query: AttributeCatalogQuery },
    responses: {
      200: { description: 'Attribute', ...json(AttributeCatalogList) },
      ...auth,
      422: problemResponse('`validation_failed` (`errors.search`); `marketplace_unsupported`'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/products/:productId/specs/:platform/apply-category',
    summary: 'Đổi category của sản phẩm trên sàn theo spec (commerio-backend#467)',
    description:
      'Cần `channel.listing.manage`; nhóm sẽ xếp có listing `contentSource = platform` (sản phẩm người bán tự đăng) thì cần thêm vai trò CEO, không thì 403 `forbidden`. Chọn listing `live`, `hidden` của sản phẩm trên mọi gian hàng của sàn, có `externalProductId`, `externalCategoryId` khác category của spec; mỗi (gian hàng, sản phẩm sàn) một việc nền `channel.category_apply`, không gọi sàn trong request. Listing được xếp có `categoryChange.status = queued`. Việc nền chỉ đổi category và attribute (adapter dựng bản sửa từ bản đọc lại trên sàn), bảng size của app chỉ gửi khi sản phẩm trên sàn chưa có mà category mới bắt buộc. Sản phẩm đang tắt thì tắt lại sau Edit Product (sàn bật lại khi sửa).',
    security: bearer,
    request: { params: ProductSpecParams, body: { content: { 'application/json': { schema: ApplyCategoryBody } } } },
    responses: {
      202: { description: 'Mỗi dòng một sản phẩm trên sàn; `code = null` là đã xếp việc', ...json(ApplyCategoryResult) },
      ...auth,
      404: problemResponse('`not_found`: sản phẩm không có hoặc của công ty khác'),
      409: problemResponse(
        '`category_unmapped` (chưa có spec); `spec_incomplete` (`categoryStatus` khác `ok` hoặc `missing` khác rỗng); `version_conflict` kèm `current`; `category_change_in_progress` (còn listing `queued`); `category_in_sync` (không listing nào lệch category); `size_chart_missing` (category mới bắt buộc bảng size mà sản phẩm chưa có)',
      ),
      422: problemResponse('`validation_failed`; `marketplace_unsupported` (adapter sàn không hỗ trợ đổi category)'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/products/:productId/listings',
    summary: 'Listing của một sản phẩm ở mọi gian hàng chưa ngắt (21 §18.5, #467)',
    description:
      'Cần `channel.shop.view`. Mỗi biến thể chưa lưu trữ × mỗi gian hàng chưa `disconnected`, tính như `GET /shops/:id/listings`, thêm `shopId`, `shopName`, `platform`. Xếp theo gian hàng (cũ trước) rồi biến thể. Không gọi sàn.',
    security: bearer,
    request: { params: ProductListingsParams },
    responses: {
      200: { description: 'Danh sách kèm `separateProducts` (#295)', ...json(ProductListingListWithSeparate) },
      ...auth,
      404: problemResponse('`not_found`: sản phẩm không có hoặc của công ty khác'),
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
      "Cần `channel.listing.manage`. Chỉ kiểm và xếp việc nền `channel.listing_push`, không gọi sàn, trả ngay (21 §18.6.4). Kết quả theo từng biến thể: dòng hợp lệ chuyển `pushing` (listing mới, hoặc đẩy lại từ `push_failed`, `rejected`, `platform_hold`; listing đã gỡ thì tạo bản ghi mới trỏ bản cũ); dòng bị chặn có `code`. Việc nền gọi sàn tối đa 5 lần: `under_review`/`live`, hoặc `push_failed` kèm `pushError`. Lỗi cả request theo thứ tự (21 §18.6.11): 409 `shop_not_active` (kèm `current`), `shop_awaiting_stocktake` (§18.6.2), `shop_awaiting_allocation` (lượt kéo đơn còn mở chưa xong hoặc phiếu đầu kỳ đã ghi sổ mà chưa phân hàng xong; problem body thêm `waitingFor: 'open_orders' | 'allocation'`), `shop_not_connected`; không dòng nào đổi, không xếp việc. `listPrices` (21 §18.9 R1): giá người bán gõ thành giá ghi đè tay (`manualPrice`), áp ngay, không thành giá chờ; thực nhận dưới giá thấp nhất thì dòng bị chặn `below_floor`; khoá không nằm trong `variantIds` thì 422 `errors[\"listPrices.<id>\"]`.",
    security: bearer,
    request: { params: ShopParams, body: json(PushBody) },
    responses: {
      200: { description: 'Kết quả theo biến thể', ...json(PushResults) },
      ...onShop,
      409: problemResponse('`shop_not_active`, `shop_awaiting_stocktake`, `shop_awaiting_allocation` kèm `waitingFor`, `shop_not_connected`; `marketplace_rejected` kèm `platformCode`, `platformMessage`'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/products/:productId/price-quote',
    summary: 'Tính thử giá niêm yết → thực nhận theo gian hàng (21 §18.9 R1)',
    description:
      'Cần `channel.listing.manage`. Không ghi gì. Thiếu `listPrice` thì dùng giá bộ lọc lần đăng sẽ gửi. Không trả giá thấp nhất; `marginPct` chỉ khi người gọi có `inventory.cost.view`. `blocked.code`: `fee_not_configured` (gian hàng chưa có phí, ba trường số null), `price_missing` (chưa có giá muốn bán và không gõ giá), `fee_config_invalid` (tổng phí từ 100%).',
    security: bearer,
    request: { params: PriceQuoteParams, body: json(PriceQuoteBody) },
    responses: {
      200: { description: 'Kết quả theo dòng, cùng thứ tự body', ...json(PriceQuoteList) },
      404: problemResponse('Gian hàng không thuộc công ty'),
      422: problemResponse('`errors["items.N.variantId"]`: SKU không thuộc sản phẩm'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/shops/:id/remote-skus',
    summary: 'SKU đang có trên sàn kèm ghép hiện hành (#220)',
    description:
      'Cần `channel.listing.match` (CEO, Admin, Sale). Đọc bản sao danh sách SKU của gian hàng BE lưu ở lần đồng bộ gần nhất (`syncedAt`: lần đọc trọn); SKU đã xoá trên sàn không có. Không gọi sàn trong request (#361): chưa có bản sao thì xếp lượt tải nền như Tải lại và trả `items: []`, `syncedAt: null`, `refresh.status = running`. Bản sao làm mới sau mỗi lượt đồng bộ listing (sản phẩm sửa từ lần trước), mỗi ngày đọc trọn một lần, và khi bấm Tải lại. `unmatched=true`: chỉ SKU chưa ghép (kể cả đang chờ CEO duyệt ghép sang "không quản tồn"). `listingId`, `listingVersion`, `pendingMapping`: listing chưa gỡ của SKU sàn và ghép chờ duyệt của nó; CEO tìm yêu cầu chờ duyệt ở đây (yêu cầu "không quản tồn" của SKU chưa ghép không có trong `GET /listings`). `refresh`: `running` (FE hỏi lại tới khi khác `running`; quá 15 phút thì `failed` mã `refresh_stale`), `failed` kèm `error` { `code`, `platformCode` (`incomplete_list`, `too_many_calls`, `daily_call_limit` …), `message` } và `retryAfterSeconds` khi lần đọc trọn lỗi gần nhất chưa quá 10 phút (không xếp lại, không 429). Chưa có bản sao mà gian hàng ngắt hoặc mất token: 409 `shop_not_connected`.',
    security: bearer,
    request: { params: ShopParams, query: RemoteSkusQuery },
    responses: {
      200: { description: 'SKU trên sàn', ...json(RemoteSkuList) },
      ...onShop,
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/shops/:id/remote-skus/refresh',
    summary: 'Tải lại danh sách SKU trên sàn (#220)',
    description:
      'Cần `channel.listing.match`. Không gọi sàn trong request (#361). Lần đọc trọn trước còn trong 60 giây: 200 trả bản sao như `GET remote-skus`. Không thì xếp lượt tải nền `channel.remote_skus_refresh` (đọc sản phẩm sửa từ lần trước rồi đọc trọn; mỗi gian hàng một lượt; lỗi sàn thử lại một lần sau 30 giây) và trả 202, `refresh.status = running`; đang có lượt chạy thì 202 không xếp thêm. FE hỏi lại `GET remote-skus` tới khi `refresh.status` khác `running`; lỗi của sàn ở `refresh.error`. Lần đọc trọn lỗi gần nhất (Tải lại hay lượt định kỳ) chưa quá 10 phút: 429 `remote_skus_retry_later`, header `Retry-After` (giây), không xếp. Gian hàng ngắt hoặc mất token: 409 `shop_not_connected`. Lượt tải tính hạn mức gọi sàn như thao tác bấm tay (dừng ở 90%). Không còn 503 `remote_skus_busy`.',
    security: bearer,
    request: { params: ShopParams, query: RemoteSkusQuery },
    responses: {
      200: { description: 'Lần đọc trọn trước còn trong 60 giây: bản sao', ...json(RemoteSkuList) },
      202: { description: 'Đã xếp hoặc đang có lượt tải nền: bản sao hiện có kèm `refresh.status = running`', ...json(RemoteSkuList) },
      ...onShop,
      409: problemResponse('`shop_not_connected` kèm `current`'),
      429: problemResponse('`remote_skus_retry_later`, có `Retry-After`'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/shops/:id/listings/match-preview',
    summary: 'Xem trước số sẽ đẩy khi ghép SKU sàn (#460, 21 §18.3)',
    description:
      'Cần `channel.listing.match`. Hộp ghép gọi khi người dùng chọn một cặp, trước nút Lưu. Đọc bản sao SKU sàn (tồn, giá gốc, lần đọc thấy gần nhất) và số của app (số có thể bán, giá đang bán sẽ đẩy: giá ghi đè tay của listing hiện có, không thì giá chuẩn), không gọi sàn, không ghi gì. Ghép xong giá app luôn được đẩy (`priceWillPush` false khi chưa có giá chuẩn). Tồn không đẩy khi gian hàng chờ kiểm kê lần đầu (`shop_waiting_opening`, xét trước) hoặc SKU kho chưa có số (`not_counted`, `app.stock` null: chưa nhập, chưa kiểm kê; tồn trên sàn giữ nguyên). Lỗi: 404 gian hàng → 422 `errors.externalSkuId` (SKU không có trong bản sao) → 422 `errors.variantId` (biến thể không thuộc công ty).',
    security: bearer,
    request: { params: ShopParams, query: MatchPreviewQuery },
    responses: { 200: { description: 'Số sàn và số app', ...json(MatchPreview) }, ...onShop },
  });
  registry.registerPath({
    method: 'post',
    path: '/shops/:id/listings/match',
    summary: 'Ghép SKU sàn với biến thể (#220, 21 §18.6.5)',
    description:
      'Cần `channel.listing.match` (CEO, Admin, Sale). SKU sàn chưa ghép: tạo listing `live`, không đẩy lại (200). Biến thể có listing lỗi đẩy chưa có mã sàn (#346): dùng lại listing đó (cùng `id`, sang `live`); SKU người bán đổi mà đã có đơn mang SKU người bán cũ thì người không tự duyệt được nhận 202, `pendingMapping.externalSkuId` là SKU sàn chờ ghép. Đổi ghép SKU sàn đã có listing sang biến thể có listing lỗi: listing lỗi tự gỡ. SKU sàn đang chờ ghép vào listing lỗi, hoặc biến thể có listing lỗi đang chờ: 409 `mapping_pending`; biến thể có listing đang đẩy: 409 `invalid_transition`. `variantId: null` là "không quản tồn". Ghép sang "không quản tồn", hoặc đổi ghép đã có đơn (gian hàng đã nhận đơn có món mang SKU người bán này): người không được tự duyệt (không phải CEO, công ty nhiều người) thì lưu `pendingMapping`, trả 202; CEO làm thì áp luôn, lịch sử ghi `selfApproved`. Ghép có hiệu lực (200, kể cả bấm lại ghép đã đúng) thì áp lên đơn đã nhận cùng gian hàng trong cùng giao dịch (#237): dòng chưa ghép ở mọi đơn được giữ hàng, trừ tồn bù; đổi ghép đã có đơn áp lên dòng đã ghép của đơn còn mở: kiện chưa đóng gói nhả theo biến thể cũ, giữ theo biến thể mới (thiếu hàng thì kiện về thiếu hàng); kiện đã đóng gói giữ món cũ, bật Cần mở `openPurpose = remap`, mở kiện ra mới áp; kiện đã rời kho giữ biến thể cũ. Lỗi khi áp (cổng tồn): 500, listing và đơn không đổi. Lỗi theo thứ tự: 404 → 409 `shop_not_active` (kèm `current`) → 409 `mapping_pending` (kèm `current`) → 409 `invalid_transition` (listing đang đẩy) → 422 `errors.variantId` (không thuộc công ty, lưu trữ, đã ghép SKU sàn khác của gian hàng) → 422 `errors.externalSkuId` (SKU chưa có listing mà không có trong bản sao SKU sàn của lần đồng bộ gần nhất, hoặc chưa có SKU người bán; không gọi sàn) → 409 `version_conflict` kèm `current` (listing mới nhất, null khi không còn; request khác vừa ghép, đổi hay gỡ SKU này). Kiểm "đã có đơn" dưới khoá dòng gian hàng, nên đơn về cùng lúc không lọt bước CEO duyệt.',
    security: bearer,
    request: { params: ShopParams, body: json(MatchBody) },
    responses: {
      200: { description: 'Đã áp ghép', ...json(ChannelListing) },
      202: { description: 'Chờ CEO duyệt: listing có `pendingMapping`', ...json(ChannelListing) },
      ...onShop,
      409: problemResponse('`shop_not_active`, `mapping_pending`, `invalid_transition`, `version_conflict` kèm `current`'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/shops/:id/listings/match-bulk',
    summary: 'Liên kết SKU sàn hàng loạt (21 §18.9 R2)',
    description:
      'Cần `channel.listing.match`. Mỗi cặp một giao dịch riêng qua đúng luật của `listings/match`, thành công được một phần: HTTP 200 kể cả khi có cặp lỗi, `results` theo thứ tự body (`matched`, `pending` chờ CEO duyệt, `failed` kèm `code`, `message` của `listings/match`). Hai cặp trùng `externalSkuId`: 422 `errors["pairs.N.externalSkuId"]`, không ghi cặp nào.',
    security: bearer,
    request: { params: ShopParams, body: json(MatchBulkBody) },
    responses: {
      200: { description: 'Kết quả theo cặp', ...json(MatchBulkResult) },
      ...onShop,
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/shops/:id/remote-skus/:externalSkuId/create-variant',
    summary: 'Tạo SKU kho từ SKU sàn rồi liên kết (21 §18.9 R2)',
    description:
      'Cần `channel.listing.match`; tạo SKU kho cần thêm `catalog.product.manage` (thiếu: 403). Cùng luật dòng `create: true` của `POST /setup` (#500): SKU người bán làm SKU kho, giá chuẩn = giá niêm yết trên sàn, giá muốn bán tính ngược theo phí của gian hàng. SKU người bán trùng SKU kho chưa lưu trữ thì không tạo, liên kết vào SKU đó (`created: false`). Một giao dịch: liên kết lỗi thì không tạo gì. Lỗi: 404 → 409 `shop_not_active` → 422 `errors.externalSkuId` (không có trong bản sao SKU sàn, không có SKU người bán, quá dài, trùng SKU kho đã lưu trữ) → 403 → 422 `errors.groupId` → lỗi của `listings/match`.',
    security: bearer,
    request: { params: CreateVariantParams, body: json(CreateVariantBody) },
    responses: {
      201: { description: 'Đã tạo SKU kho và liên kết', ...json(CreateVariantResult) },
      200: { description: 'Liên kết vào SKU kho có sẵn', ...json(CreateVariantResult) },
      202: { description: 'Liên kết vào SKU kho có sẵn, chờ CEO duyệt', ...json(CreateVariantResult) },
      ...onShop,
      409: problemResponse('`shop_not_active`, và lỗi 409 của `listings/match`'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/shops/:id/listings/:listingId/mapping/:action',
    summary: 'CEO duyệt hoặc từ chối ghép chờ (#220, 21 §18.6.5)',
    description:
      'Cần `channel.listing.manage` và vai trò CEO (người khác: 403 `forbidden`). `approve`: áp ghép mới (kiểm lại biến thể, 422 `errors.variantId`), rồi áp lên đơn đã nhận cùng gian hàng như `listings/match` (#237): dòng chưa ghép được giữ hàng, trừ tồn bù; đổi ghép đã có đơn áp lên dòng đã ghép của đơn còn mở (kiện chưa đóng gói nhả cũ, giữ mới; kiện đã đóng gói bật Cần mở `remap`; kiện đã rời kho giữ nguyên). `reject`: bắt buộc `reason` (422 `errors.reason`), bỏ ghép chờ; listing tạo ra chỉ để chờ duyệt "không quản tồn" thì xoá, body là listing lúc xoá. Thứ tự: 404 → 409 `invalid_transition` (không có `pendingMapping`, listing đã gỡ hoặc đang đẩy) → 409 `version_conflict` (kèm `current`); hai lần duyệt đua về cùng biến thể: lần sau 422 `errors.variantId`.',
    security: bearer,
    request: { params: MappingParams, body: json(MappingBody) },
    responses: {
      200: { description: 'Listing sau khi duyệt hoặc từ chối', ...json(ChannelListing) },
      ...auth,
      404: problemResponse('`not_found`: gian hàng hoặc listing'),
      409: problemResponse('`invalid_transition`, `second_person_required` (người xin tự duyệt mà không được tự duyệt), `version_conflict` kèm `current`'),
      422: problemResponse('`validation_failed` (`errors.reason`, `errors.variantId`)'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/shops/:id/setup',
    summary: 'Gợi ý ghép listing có sẵn khi thiết lập lần đầu (§18.2)',
    description:
      'Cần `channel.shop.connect`. Mọi SKU người bán trên sàn (sàn chưa đọc được cả gian hàng thì chỉ SKU trùng SKU Commerio), mỗi dòng `match` `sku` / `name` (tên giống từ 0.4 theo pg_trgm, kèm `score`) / `none`; biến thể lưu trữ hay đã có listing ở gian hàng không được gợi ý; SKU sàn trùng tiêu đề với SKU khác (một sản phẩm nhiều SKU) hoặc không có SKU người bán không được gợi ý theo tên (21 §18.7.5). `proposedCutoffAt`, `firstShopOfCompany` (§18.6.2). Gian hàng không ở `connecting`: 409 `invalid_transition`. Gian hàng vượt giới hạn đọc của sàn: 409 `marketplace_rejected` `too_many_products`.',
    security: bearer,
    request: { params: ShopParams },
    responses: { 200: { description: 'Gợi ý', ...json(ShopSetupPreview) }, ...onShop },
  });
  registry.registerPath({
    method: 'post',
    path: '/shops/:id/setup',
    summary: 'Hoàn tất thiết lập lần đầu (§18.2)',
    description:
      'Cần `channel.shop.connect`. Tạo listing `live` theo `decisions` (hoặc `externalSkuIds` cũ), mốc kéo đơn = lúc gọi (`orderCutoffAt` trong body bị bỏ qua, §18.7.6), gian hàng `connecting → active`, xếp lượt kéo đơn còn mở; lúc này chỉ đẩy giá, tồn đẩy sau lượt đó (`Shop.setup`). `stocktake`: lập phiếu kiểm kê đầu kỳ, gian hàng ở chế độ chờ kiểm kê (`openingStocktake`). Sai: 422 `errors.openingStock` (gian hàng đầu tiên của công ty gửi `push`; công ty đang chờ phiếu đầu kỳ khác), `errors.decisions` (gửi cả `externalSkuIds`), `errors["decisions.<i>"]` (SKU không có trong gợi ý, SKU sàn chưa có SKU người bán, lặp, biến thể không thuộc công ty, lưu trữ, đã ghép ở gian hàng; tối đa 10000 dòng). Kiểm lại dưới khoá của công ty nên hai lần thiết lập cùng công ty chạy lần lượt, `errors.externalSkuIds`, `errors.returnWindowDays` (sàn `capabilities.returnWindow = days`: số nguyên 1–60, bắt buộc, thiếu hoặc `null` cũng lỗi; sàn `platform_status` bỏ qua, lưu null).',
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
    summary: 'Xếp một lượt đồng bộ listing với sàn (#104, #223)',
    description:
      'Cần `channel.shop.sync`. Không gọi sàn trong request: xếp một lượt `channel.listing_sync` (cùng việc chạy mỗi 15 phút) rồi trả 202. Lượt đó lấy đơn mới, đọc trạng thái sàn của listing mình (duyệt, từ chối, khoá, gỡ khoá, xoá), đối chiếu tồn, đẩy giá chuẩn và số có thể bán của listing `stockSync`/`priceSync` khác `synced`; kết quả xem ở danh sách listing. Đã có lượt chờ thì `queued: false`, không xếp thêm. Gian hàng không `active` hoặc mất token: 409 `shop_not_connected` kèm `current`.',
    security: bearer,
    request: { params: ShopParams },
    responses: { 202: { description: 'Đã xếp hoặc đã có lượt chờ', ...json(ListingSyncResult) }, ...onShop },
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
  registry.registerPath({
    method: 'get',
    path: '/listings/pending-prices',
    summary: 'Giá chờ xác nhận (#225, 21 §21.4)',
    description:
      'Cần `channel.listing.manage`. Bản chờ do đổi giá muốn bán hoặc kích hoạt phí, thuế, lãi tối thiểu sinh ra (Documents/25 §6.2), mới trước. Không trả giá vốn, giá thấp nhất.',
    security: bearer,
    request: { query: PendingPricesQuery },
    responses: { 200: { description: 'Một trang giá chờ', ...json(PendingPricePage) }, ...auth, 404: problemResponse('`not_found`: gian hàng') },
  });
  registry.registerPath({
    method: 'post',
    path: '/listings/:id/confirm-price',
    summary: 'Xác nhận giá chờ của listing (#225)',
    description:
      'Cần `channel.listing.manage`. `version` là của listing. Giá chờ thành giá đang bán (`priceSource = shop`), bỏ giá ghi đè tay, `priceSync = pending` để lượt đồng bộ đẩy lên sàn.',
    security: bearer,
    request: { params: ListingIdParams, body: json(ConfirmPriceBody) },
    responses: {
      200: { description: 'Listing sau khi xác nhận', ...json(ChannelListing) },
      ...auth,
      404: problemResponse('`not_found`'),
      409: problemResponse('`invalid_transition` (không có giá chờ), `version_conflict`'),
      422: problemResponse('`below_floor`: giá chờ dưới giá thấp nhất'),
    },
  });
  registry.registerPath({
    method: 'put',
    path: '/shops/:id/listings/:listingId/price',
    summary: 'Ghi đè tay giá listing (#225, 25 §6.2 bước 6)',
    description:
      'Cần `channel.listing.manage`. `price` null bỏ ghi đè. Giá ghi đè vẫn qua bước 5: thực nhận dưới giá thấp nhất trả 422 `below_floor`. `priceSync = pending`.',
    security: bearer,
    request: { params: ManualPriceParams, body: json(ManualPriceBody) },
    responses: {
      200: { description: 'Listing sau khi sửa giá', ...json(ChannelListing) },
      ...auth,
      404: problemResponse('`not_found`: gian hàng hoặc listing'),
      409: problemResponse('`version_conflict`'),
      422: problemResponse('`validation_failed` (`errors.price`), `below_floor`, `fee_config_invalid`'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/shops/:id/listings/:listingId/outside-change/:action',
    summary: 'CEO quyết listing bị sàn đổi ngoài app (#360, 21 §18.3)',
    description:
      'Cần `channel.listing.manage` và vai trò CEO (người khác: 403 `forbidden`). `restore`: sàn đã bán lại thì không gọi bật, không thì bật SKU trên sàn; `hidden → live`, xoá `outsideChange`, đẩy lại tồn và giá của app. Sàn tắt theo cả sản phẩm: quyết cho mọi listing `disabled` cùng sản phẩm, listing còn ẩn được đẩy tồn 0 trước khi bật sản phẩm (sàn duyệt lại); đẩy 0 lỗi thì 409 `marketplace_rejected`, không bật. Sàn chưa hỗ trợ bật từ app: 422 `marketplace_unsupported`. SKU đang tạm ngừng: chỉ xoá `outsideChange`, listing giữ `hidden`. `accept-price` chỉ với `outsideChange.kind = price_changed`, chỉ listing được bấm: giá sàn thành giá ghi đè tay (`priceSource = override`), bật SKU, `hidden → live`, không đẩy giá; giá sàn dưới giá thấp nhất trả 422 `below_floor`. Gỡ dùng route `delist`.',
    security: bearer,
    request: { params: OutsideChangeParams, body: json(OutsideChangeBody) },
    responses: {
      200: { description: 'Listing sau khi quyết', ...json(ChannelListing) },
      ...onShop,
      404: problemResponse('`not_found`: gian hàng hoặc listing'),
      409: problemResponse('`invalid_transition` (không có `outsideChange`; `accept-price` với `kind = disabled`), `version_conflict` kèm `current`, `shop_not_connected`'),
      422: problemResponse('`marketplace_unsupported`, `validation_failed`, `below_floor` (`accept-price`)'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/shops/:id/listings/:listingId/take-over-content',
    summary: 'CEO ghi nội dung Commerio lên sản phẩm người bán đã ghép (#399)',
    description:
      'Cần `channel.listing.manage` và vai trò CEO (người khác: 403 `forbidden`). Chỉ listing `contentSource = platform` có mã sàn ở `live`, `platform_hold`, `rejected`, `push_failed` (`hidden`: 409, hiện lại listing trước vì `updateProduct` bật SKU trên sàn). Kiểm gian hàng như `push` (`shop_not_active`, `shop_awaiting_stocktake`, `shop_awaiting_allocation`, `shop_not_connected`). ' +
      'Listing chuyển `pushing` (`take_over_content`), xếp việc đẩy ghi tên, mô tả, ảnh, danh mục, thuộc tính, giá của Commerio lên sản phẩm (nội dung đang có trên sàn mất, không hoàn tác); ' +
      'xong thì `contentSource = app`, `live` hoặc `under_review`; sàn lỗi (từ chối, hết lượt thử, quá 30 phút) thì kèm `pushError`, giữ `platform`: xuất phát từ `live` về `live` (tồn, giá chờ đẩy lại), xuất phát từ trạng thái khác `push_failed`. Ghi nhật ký thao tác.',
    security: bearer,
    request: { params: TakeOverContentParams, body: json(TakeOverContentBody) },
    responses: {
      202: { description: 'Listing `pushing`, việc ghi nội dung đã xếp', ...json(ChannelListing) },
      ...onShop,
      404: problemResponse('`not_found`: gian hàng, listing, hoặc biến thể không còn bán'),
      409: problemResponse(
        '`invalid_transition` kèm `current` (listing `app`, chưa có mã sàn, `hidden`, trạng thái khác, đang chờ CEO quyết thay đổi ngoài app), `mapping_pending`, `version_conflict` kèm `current`, `shared_remote_product` (sản phẩm trên sàn có nhiều SKU, ghi đè cả sản phẩm), `shop_not_active`, `shop_awaiting_stocktake`, `shop_awaiting_allocation`, `shop_not_connected`, mã chặn đẩy (`category_unmapped`, `price_missing`, `dimensions_missing`, `images_missing`, `size_chart_missing`, `sku_not_ready`)',
      ),
      422: problemResponse('`validation_failed`'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/shops/:id/listings/:listingId/acknowledge-title',
    summary: 'Xác nhận tên trên sàn đã đổi (#396, 21 §18.3)',
    description:
      'Cần `channel.listing.manage`. Listing có `remoteTitleChanged` (trên `ListingRow`, phần tử `remote-skus`): mốc tên lúc ghép thành tên hiện tại trong bản sao SKU sàn (cả tên tiếng Anh), xoá cờ, tăng `version`, ghi nhật ký thao tác. Không gọi sàn, không đổi tên trong catalog. Cờ bật khi lần đọc bản sao thấy (tên, tên tiếng Anh) khác mốc; ghép, đổi ghép, CEO duyệt ghép đặt mốc từ bản sao; app đẩy, sửa nội dung đặt mốc là tên app vừa gửi.',
    security: bearer,
    request: { params: AcknowledgeTitleParams, body: json(AcknowledgeTitleBody) },
    responses: {
      200: { description: 'Listing sau khi xác nhận', ...json(ChannelListing) },
      ...auth,
      404: problemResponse('`not_found`: gian hàng hoặc listing'),
      409: problemResponse('`invalid_transition` (không có `remoteTitleChanged`), `version_conflict` kèm `current`'),
      422: problemResponse('`validation_failed` (`errors.version`)'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/shops/:id/listings/:listingId/update-content',
    summary: 'Đưa nội dung mới của sản phẩm lên listing đang bán (§18.3, #293)',
    description:
      'Cần `channel.listing.manage`. Tên, mô tả, thuộc tính bắt buộc dựng từ catalog như lúc đẩy; không đổi ảnh, SKU, giá, tồn. ' +
      'Sàn vẫn bán bản cũ trong lúc duyệt thì giữ `live` kèm `pendingRevision.status = auditing`; sàn ngừng bán để ' +
      'duyệt thì `under_review` (hệ thống `request_review`). Đồng bộ 15 phút xoá bản sửa khi qua duyệt, ghi `failed` khi trượt.',
    security: bearer,
    request: { params: UpdateContentParams, body: json(UpdateContentBody) },
    responses: {
      200: { description: 'Listing sau khi gửi bản sửa', ...json(ChannelListing) },
      ...onShop,
      404: problemResponse('`not_found`: gian hàng, listing, hoặc biến thể không còn bán'),
      409: problemResponse(
        '`invalid_transition` (listing không `live`; `contentSource = platform`: CEO dùng take-over-content), `version_conflict` kèm `current`, `listing_unmanaged`, `shared_remote_product`, `category_unmapped`, `marketplace_rejected` (kể cả danh mục sàn khác ghép)',
      ),
      422: problemResponse('`marketplace_unsupported`: sàn chưa hỗ trợ sửa nội dung'),
      503: problemResponse('`marketplace_unavailable`'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/shops/:id/products/:productId/regroup',
    summary: 'Gom các sản phẩm sàn riêng của một sản phẩm thành một (#295, 21 §18.8.4)',
    description:
      'Cần `channel.listing.manage` và vai trò CEO (người khác: 403 `forbidden`; gỡ sản phẩm người bán đã đăng). Dùng cho dữ liệu cũ: các SKU chưa gỡ của sản phẩm nằm ở hơn một sản phẩm sàn trên gian hàng (`separateProducts` của `GET /products/:productId/listings`). ' +
      'Lỗi theo thứ tự: 404 gian hàng, sản phẩm → 409 `shop_not_active`, `shop_awaiting_stocktake`, `shop_awaiting_allocation`, `shop_not_connected` → 409 `nothing_to_regroup` → 409 `invalid_transition` kèm `current` (listing đang `pushing`, có `outsideChange`, ghép chờ duyệt, hoặc sản phẩm đang đẩy hay gom) → 409 `push_blocked` kèm `rows: { variantId, code }[]` (mã chặn đẩy: `price_missing`, `category_unmapped`, `spec_incomplete`, `dimensions_missing`, `images_missing`, …). ' +
      'Hợp lệ: xếp việc `channel.product_regroup`, trả 202. Việc nền tạo một sản phẩm nhiều phân loại cho mọi SKU đang có listing chưa gỡ, rồi xoá các sản phẩm lẻ trên sàn. Listing cũ `delisted` (lý do "Gom thành một sản phẩm"), listing mới `replacesListingId` trỏ listing cũ. Tạo lỗi: không gỡ gì, listing cũ giữ nguyên. Xoá sản phẩm lẻ lỗi: lượt sau thử xoá tiếp (gọi lại route này). Sàn chưa hỗ trợ xoá sản phẩm: 422 `marketplace_unsupported`.',
    security: bearer,
    request: { params: RegroupParams },
    responses: {
      202: { description: 'Đã xếp việc gom', ...json(RegroupQueued) },
      ...auth,
      404: problemResponse('`not_found`: gian hàng hoặc sản phẩm'),
      409: problemResponse(
        '`shop_not_active`, `shop_awaiting_stocktake`, `shop_awaiting_allocation`, `shop_not_connected`, `nothing_to_regroup`, `invalid_transition` kèm `current`, `push_blocked` kèm `rows`',
      ),
      422: problemResponse('`marketplace_unsupported`'),
    },
  });
}
