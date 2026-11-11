import { z } from 'zod';
import { ProblemDetailsSchema } from '../../../../shared/http/openapi.ts';

// Sàn kiểm theo danh sách adapter đã đăng ký ở service (422 `marketplace_unsupported`, Documents/21 §18.4), không viết cứng ở đây.
export const PlatformParams = z.object({ platform: z.string().max(40) });

// `id` sai định dạng trả 404 ở service, nên ở đây chỉ là chuỗi.
export const ShopParams = z.object({ id: z.string() });

// Thiếu hoặc rỗng `state` là 422 `oauth_state_invalid` ở service (21 §18.6.3), nên ở đây không `min(1)`.
export const CallbackBody = z
  .object({
    state: z.string().max(4000).optional().meta({ description: '`state` trên URL callback, do `authorize-url` phát' }),
    params: z
      .record(z.string().max(64), z.string().max(2000))
      .refine((p) => Object.keys(p).length <= 20, 'Tối đa 20 tham số')
      .optional()
      .meta({ description: 'Mọi query trên URL callback trừ `state`; adapter tự đọc (Lazada: `code`)' }),
    code: z.string().trim().min(1).max(2000).optional().meta({
      deprecated: true,
      description: 'Body cũ `{ code, state }`, coi như `params = { code }`; bỏ sau khi FE gửi `params` (21 §18.6.3)',
    }),
  })
  .refine((b) => b.params !== undefined || b.code !== undefined, { path: ['params'], message: 'Thiếu tham số callback' })
  .meta({ id: 'ShopCallbackInput' });

export const TokenBody = z
  .object({
    accessToken: z.string('Nhập access token').trim().min(1, 'Nhập access token').max(2000),
    refreshToken: z.string().trim().min(1).max(2000).optional(),
  })
  .meta({ id: 'ShopTokenInput', description: 'Token lấy trên console của sàn (shop thử không đi OAuth được)' });

export const DisconnectBody = z
  .object({
    version: z.number('Thiếu version').int().positive(),
    zeroStock: z.boolean().default(false).meta({ description: 'Đẩy tồn 0 cho listing còn trên sàn trước khi ngắt' }),
  })
  .meta({ id: 'ShopDisconnectInput' });


// Schema trả về: Swagger và test integration parse body bằng chính các schema này (Documents/21 §1.1).
const iso = z.iso.datetime();

export const StatusChange = z
  .object({
    at: iso,
    from: z.string().nullable(),
    to: z.string(),
    by: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    source: z.enum(['user', 'marketplace', 'system']),
    reason: z.string().nullable(),
  })
  .strict()
  .meta({ id: 'StatusChange' });

export const ShopCapabilities = z
  .object({
    listingReview: z.boolean().meta({ description: 'Sàn duyệt listing trước khi bán' }),
    hideBy: z.enum(['deactivate', 'zero_stock']).meta({ description: 'Ẩn listing bằng tắt hay bằng đẩy tồn 0' }),
    splitLevel: z.enum(['unit', 'sku', 'none']).meta({ description: 'Mức tách kiện sàn cho phép' }),
    returnWindow: z.enum(['days', 'platform_status']).meta({
      description: '`days`: hạn trả tính bằng `Shop.returnWindowDays`; `platform_status`: theo trạng thái sàn',
    }),
  })
  .strict()
  .meta({ id: 'ShopCapabilities', description: 'Năng lực sàn do adapter khai (Documents/21 §18.6.3); FE rẽ nhánh theo đây, không theo mã sàn' });

export const Shop = z
  .object({
    id: z.uuid(),
    companyId: z.uuid(),
    platform: z.string().meta({ description: 'Mã sàn (`ShopPlatform.platform`)' }),
    externalShopId: z.string().meta({ description: 'Mã shop của sàn (Lazada: `seller_id`)' }),
    shopName: z.string(),
    region: z.string().nullable(),
    status: z.enum(['connecting', 'active', 'needs_reauth', 'disconnected']),
    accessExpiresAt: iso.nullable(),
    refreshExpiresAt: iso.nullable(),
    authExpiresAt: iso
      .nullable()
      .meta({ description: 'Hạn uỷ quyền seller chọn trên sàn; null khi sàn không có hạn riêng ngoài refreshExpiresAt (Lazada, TikTok)' }),
    tokenExpiringSoon: z
      .boolean()
      .meta({ description: 'Đang active và hạn gần hơn trong authExpiresAt, refreshExpiresAt còn dưới 3 ngày' }),
    lastOrderSyncAt: iso.nullable(),
    orderCutoffAt: iso.nullable().meta({ description: 'Mốc kéo đơn, null khi chưa thiết lập' }),
    capabilities: ShopCapabilities,
    returnWindowDays: z.number().int().nullable().meta({
      description: 'Hạn trả hàng (ngày, 1–60) nhập lúc thiết lập; null khi chưa nhập hoặc sàn `returnWindow = platform_status`',
    }),
    openingStocktake: z
      .object({
        documentId: z.uuid(),
        number: z.string(),
        status: z.enum(['draft', 'pending', 'rejected', 'posted', 'cancelled']).meta({ description: 'Trạng thái phiếu kho (21 §15.3)' }),
      })
      .strict()
      .nullable()
      .meta({
        description:
          'Phiếu kiểm kê đầu kỳ đang chờ ghi sổ. Khác null: gian hàng `active` ở chế độ chờ kiểm kê lần đầu, không đẩy tồn, không giữ hàng, đẩy listing 409 `shop_awaiting_stocktake` (21 §18.6.2)',
      }),
    setup: z
      .object({
        steps: z.array(
          z
            .object({
              key: z.enum(['match', 'opening_stock', 'open_orders', 'push_stock']),
              status: z.enum(['pending', 'running', 'done', 'failed', 'blocked']),
              blockedBy: z.string().nullable().meta({ description: 'Bước đang chặn (`opening_stock`, `open_orders`) hoặc mã issue chưa làm; null khi không `blocked`' }),
            })
            .strict(),
        ),
        unmatchedCount: z.number().int().meta({ description: 'Số SKU sàn chưa ghép sau thiết lập, gồm SKU bỏ qua' }),
        openOrdersSkipped: z.number().int().meta({
          description:
            'Số đơn còn mở đặt trước mốc không kéo về vì vượt trần `OPEN_ORDER_PULL_MAX` (chỉ lấy các đơn đặt mới nhất); 0 khi không cắt. Hàng của các đơn này không được giữ',
        }),
      })
      .strict()
      .nullable()
      .meta({
        description:
          'Tiến độ thiết lập (21 §18.7.7). `connecting`: chỉ bước `match` `pending`. Null khi thiết lập trước commerio-backend#198, đã ngắt, hoặc mọi bước xong quá 24 giờ. Còn bước `running` thì FE gọi lại mỗi 3 giây',
      }),
    pendingJobs: z.number().int(),
    listingCount: z.number().int().meta({ description: 'Số listing còn trên sàn' }),
    pendingOrderCount: z.number().int().meta({
      description: 'Số đơn của gian hàng chưa `completed` hoặc `cancelled`, cùng cách đếm với `openOrders` của ngắt (21 §18.7.1)',
    }),
    orders7d: z.number().int().meta({
      description: 'Số đơn khách đặt trong 7 × 24 giờ tính lùi từ lúc gọi, theo `placedAt` của đơn (lúc đặt trên sàn) (21 §18.7.1)',
    }),
    statusChangedAt: iso.meta({ description: 'Lần đổi `status` gần nhất; chưa đổi lần nào thì bằng `createdAt` (21 §18.7.1)' }),
    feeConfigVersion: z.number().int().nullable().meta({
      description: 'Số phiên bản cấu hình phí đang áp cho gian hàng (21 §21.4); `null` tới khi có commerio-backend#230',
    }),
    version: z.number().int(),
    createdAt: iso,
    updatedAt: iso,
  })
  .strict()
  .meta({ id: 'Shop' });

/** 409 của ngắt (§18.6.1, #207): `shop_has_open_orders` thêm `openOrders`, `orders` (§18.7.8); `version_conflict`, `invalid_transition` thêm `current`. */
export const ShopDisconnectConflict = ProblemDetailsSchema.extend({
  openOrders: z
    .number()
    .int()
    .min(1)
    .optional()
    .meta({ description: 'Số đơn chưa `completed` hoặc `cancelled`, chỉ có với `shop_has_open_orders`' }),
  orders: z
    .array(z.object({ id: z.uuid(), code: z.string(), externalOrderId: z.string().nullable() }).strict())
    .max(20)
    .optional()
    .meta({
      description:
        'Chỉ có với `shop_has_open_orders`: tối đa 20 đơn chưa xong, cũ nhất trước (theo lúc đặt); `openOrders` là tổng, có thể lớn hơn 20 (21 §18.7.8)',
    }),
  current: z
    .union([Shop, z.enum(['connecting', 'active', 'needs_reauth', 'disconnected'])])
    .optional()
    .meta({ description: '`version_conflict`: gian hàng hiện tại; `invalid_transition`: trạng thái hiện tại' }),
}).meta({ id: 'ShopDisconnectConflict' });

export const ShopDetail = Shop.extend({ statusHistory: z.array(StatusChange) }).meta({ id: 'ShopDetail' });

export const ShopList = z.object({ items: z.array(Shop) }).strict().meta({ id: 'ShopList' });

export const ShopPlatform = z
  .object({
    platform: z.string().meta({ description: 'Mã sàn, dùng ở `/shops/:platform/...`' }),
    name: z.string().meta({ description: 'Tên sàn hiển thị' }),
    connectable: z.boolean().meta({ description: 'Nối được trên môi trường này (21 §18.7.3)' }),
    reason: z.string().nullable().meta({
      description: 'Lý do cho người đọc khi `connectable: false` (sàn chưa có adapter, môi trường chưa cấu hình); `null` khi nối được',
    }),
    methods: z.array(z.enum(['oauth', 'token'])).meta({
      description:
        '`oauth`: qua trang uỷ quyền (`authorize-url`, `callback`); `token`: dán token console (`POST /shops/:platform/token`). Rỗng khi `connectable: false`',
    }),
    capabilities: ShopCapabilities.meta({
      description: 'Luôn có (R4). Sàn chưa có adapter nhận bộ thận trọng; FE không đọc khi `connectable: false`',
    }),
  })
  .strict()
  .meta({ id: 'ShopPlatform' });

export const ShopPlatformList = z.object({ items: z.array(ShopPlatform) }).strict().meta({ id: 'ShopPlatformList' });

const connectionResult = {
  shop: Shop,
  created: z.boolean(),
  reconnect: z
    .object({ pulledFrom: iso.nullable(), relisted: z.number().int(), jobsRun: z.number().int() })
    .strict()
    .nullable(),
};

export const ShopConnectionResult = z
  .object({
    ...connectionResult,
    previousStatus: z.enum(['connecting', 'active', 'needs_reauth', 'disconnected']).nullable().meta({
      description: 'Trạng thái gian hàng ngay trước lần nối này; `null` khi `created: true` (21 §18.7.4)',
    }),
    remoteProductCount: z.number().int().nullable().meta({
      description:
        'Số sản phẩm người bán có trên sàn lúc nối, không tính sản phẩm đã xoá trên sàn. Nghĩa cố định cho mọi sàn, sàn nào cũng trả; BE lấy bằng tổng sàn trả sẵn, không đọc hết danh sách (Lazada: `total_products` của GetProducts, `filter=all`; TikTok: `total_count` của Search Products). `null` chỉ khi BE chưa đọc được: adapter của sàn chưa có cách đếm, sàn lỗi (kể cả hết hạn mức gọi, sàn không trả lời) hoặc quá 10 giây. BE không trả 0 thay cho lỗi; việc nối vẫn xong (21 §18.7.4)',
    }),
    remoteSkuCount: z.number().int().nullable().meta({
      description:
        'Số phân loại người bán có trên sàn lúc nối. Phân loại là SKU của sàn; sản phẩm không chia phân loại tính là 1. Không tính phân loại của sản phẩm đã xoá. Nghĩa cố định cho mọi sàn. `null` khi BE chưa biết: sàn không trả tổng số phân loại và BE chưa đọc hết danh sách (Lazada lúc nối luôn `null`; TikTok `null` khi tổng sản phẩm của gian hàng, kể cả sản phẩm đã xoá, vượt một trang (100)), hoặc khi `remoteProductCount` là `null`. BE không suy số phân loại từ số sản phẩm (21 §18.7.4)',
    }),
  })
  .strict()
  .meta({ id: 'ShopConnectionResult' });

export const ShopCallbackResult = z
  .object({
    ...connectionResult,
    shops: z.array(ShopConnectionResult).min(1).meta({
      description:
        'Mọi gian hàng của lần nối (một lần uỷ quyền có thể ra nhiều gian hàng); `shop`, `created`, `reconnect` là của phần tử đầu. `previousStatus`, `remoteProductCount`, `remoteSkuCount` chỉ có ở đây, gốc không có',
    }),
  })
  .strict()
  .meta({ id: 'ShopCallbackResult' });

export const AuthorizeUrl = z.object({ url: z.url() }).strict().meta({ id: 'ShopAuthorizeUrl' });

// Ghép danh mục (#104 A2).
export const CategoryParams = z.object({ id: z.string(), externalId: z.string().trim().min(1).max(40) });
export const CategoryMapParams = z.object({ id: z.string(), categoryId: z.uuid('Danh mục không hợp lệ') });
export const CategorySearchQuery = z.object({ search: z.string().trim().max(100).default('') });

export const CategoryMapBody = z
  .object({
    externalCategoryId: z.string('Chọn danh mục sàn').trim().min(1, 'Chọn danh mục sàn').max(40),
    attributes: z.record(z.string().max(60), z.string().trim().max(500)).default({}),
    version: z.number().int().positive().nullable().meta({ description: 'null khi ghép mới' }),
  })
  .meta({ id: 'CategoryMapInput' });

export const PlatformCategoryList = z
  .object({ items: z.array(z.object({ externalId: z.string(), name: z.string() }).strict()) })
  .strict()
  .meta({ id: 'PlatformCategoryList', description: 'Danh mục lá của sàn, `name` là cả đường dẫn' });

export const CategoryAttributeList = z
  .object({
    items: z.array(z.object({ name: z.string(), label: z.string(), options: z.array(z.string()) }).strict()),
  })
  .strict()
  .meta({ id: 'CategoryAttributeList', description: 'Thuộc tính bắt buộc cấp sản phẩm; `options` rỗng là nhập tự do' });

export const CategoryMap = z
  .object({
    categoryId: z.uuid(),
    platform: z.string().meta({ description: 'Mã sàn (`ShopPlatform.platform`)' }),
    externalCategoryId: z.string(),
    attributes: z.record(z.string(), z.string()),
    version: z.number().int(),
    updatedAt: iso,
  })
  .strict()
  .meta({ id: 'CategoryMap' });

export const CategoryMapList = z.object({ items: z.array(CategoryMap) }).strict().meta({ id: 'CategoryMapList' });

// Listing (#104; Documents/21 §18.3, §18.4).
export const ListingParams = z.object({ id: z.string(), variantId: z.uuid('Biến thể không hợp lệ') });

const httpUrl = z.url({ protocol: /^https?$/, error: 'URL ảnh phải là http(s)' }).max(2000);
export const PushBody = z
  .object({
    variantIds: z.array(z.uuid('Biến thể không hợp lệ')).min(1, 'Chọn ít nhất một biến thể').max(20, 'Tối đa 20 biến thể mỗi lần'),
    imageUrls: z
      .record(z.uuid(), z.array(httpUrl).min(1).max(8))
      .default({})
      .meta({
        description:
          'URL ảnh công khai theo `productId` (JPG/PNG ≥ 330×330, ≤ 1MB); BE đưa lên sàn. Bắt buộc lần đầu đẩy sản phẩm, vì catalog chưa lưu ảnh',
      }),
  })
  .meta({ id: 'ListingPushInput' });

export const DelistBody = z.object({ version: z.number('Thiếu version').int().positive() }).meta({ id: 'ListingDelistInput' });

const listingStatus = z.enum(['pushing', 'push_failed', 'under_review', 'rejected', 'live', 'hidden', 'platform_hold', 'delisted']);
const syncState = z.enum(['synced', 'pending', 'error']);
const syncError = z.object({ code: z.string(), message: z.string(), at: iso }).strict().nullable();

export const ChannelListing = z
  .object({
    id: z.uuid(),
    externalProductId: z.string().nullable(),
    externalSkuId: z.string().nullable(),
    sellerSku: z.string().nullable(),
    status: listingStatus,
    rejectReason: z.string().nullable(),
    pushError: z.string().nullable(),
    pushAttempts: z.number().int(),
    hiddenBy: z.enum(['platform', 'zero_stock']).nullable(),
    stockSync: syncState,
    priceSync: syncState,
    platformStock: z.number().int().nullable(),
    stockSyncError: syncError.meta({ description: 'Lỗi lần đẩy tồn gần nhất của riêng SKU này; `message` là câu của sàn' }),
    priceSyncError: syncError,
    qcAlert: z.null().meta({ description: 'Cảnh báo QC của sàn; chưa đọc, luôn null' }),
    lastPushedAt: iso.nullable(),
    lastPushedPrice: z.number().int().nullable(),
    version: z.number().int(),
  })
  .strict()
  .meta({ id: 'ChannelListing' });

export const ListingRow = z
  .object({
    variantId: z.uuid(),
    productId: z.uuid(),
    productName: z.string(),
    sku: z.string(),
    attributesLabel: z.string(),
    thumbnailUrl: z.null(),
    price: z.number().int().nullable().meta({ description: 'Giá sẽ đẩy: giá chuẩn của SKU' }),
    priceSource: z.enum(['standard']).nullable(),
    listing: ChannelListing.nullable(),
  })
  .strict()
  .meta({ id: 'ListingRow' });

export const ListingList = z.object({ items: z.array(ListingRow) }).strict().meta({ id: 'ListingList' });

export const PushResult = z
  .object({
    variantId: z.string(),
    sku: z.string(),
    outcome: z.enum(['created', 'updated', 'failed']),
    status: listingStatus.optional(),
    externalSkuId: z.string().optional(),
    code: z.string().optional().meta({
      description:
        '`not_found`, `push_in_progress`, `platform_hold`, `already_listed`, `price_missing`, `category_unmapped`, `dimensions_missing`, `images_missing`, `marketplace_rejected`, `marketplace_unavailable`',
    }),
    message: z.string().optional(),
  })
  .strict()
  .meta({ id: 'PushResult' });

export const PushResults = z.object({ results: z.array(PushResult) }).strict().meta({ id: 'PushResults' });

export const ListingSyncResult = z
  .object({
    checked: z.number().int().meta({ description: 'Số listing đã đọc trạng thái từ sàn' }),
    changed: z.number().int().meta({ description: 'Số listing đổi trạng thái' }),
    pushed: z.number().int().meta({ description: 'Số SKU đã đẩy giá, tồn' }),
    errors: z.number().int().meta({ description: 'Số SKU đẩy lỗi (xem `stockSyncError`, `priceSyncError`)' }),
  })
  .strict()
  .meta({ id: 'ListingSyncResult' });

export const OrderPullResult = z
  .object({
    pulled: z.number().int().meta({ description: 'Số đơn có cập nhật mới, đã lấy chi tiết từ sàn' }),
    created: z.number().int().meta({ description: 'Số đơn mới tạo' }),
    updated: z.number().int().meta({ description: 'Số đơn đổi trạng thái, cờ hoặc kiện' }),
  })
  .strict()
  .meta({ id: 'OrderPullResult' });

// Thiết lập lần đầu (§18.2). Mốc kéo đơn do BE đặt là lúc gọi; FE cũ còn gửi `orderCutoffAt` thì khoá lạ bị bỏ (không `.strict()`).
export const SetupBody = z
  .object({
    externalSkuIds: z.array(z.string().trim().min(1).max(40)).max(10_000).optional().meta({
      description: 'Cũ, giữ tới hết đợt 2: SKU sàn nhận biến thể gợi ý. Gửi cùng `decisions` thì 422 `errors.decisions` (21 §18.7.5)',
    }),
    decisions: z
      .array(z.object({ externalSkuId: z.string().trim().min(1).max(40), variantId: z.uuid().nullable() }).strict())
      .max(10_000)
      .optional()
      .meta({
        description:
          'Biến thể người dùng chọn cho từng SKU sàn, `null` là bỏ qua; SKU không có trong mảng cũng bỏ qua. Dòng sai: 422 `errors["decisions.<i>"]` (21 §18.7.5)',
      }),
    openingStock: z.enum(['push', 'stocktake'], 'Chọn cách xử lý tồn đầu kỳ'),
    returnWindowDays: z.number('Hạn trả hàng là số ngày').int('Hạn trả hàng là số ngày nguyên').nullable().optional().meta({
      description:
        'Hạn trả hàng (ngày, 1–60) khi `shop.capabilities.returnWindow = days`; sàn `platform_status` bỏ qua và lưu null. Chưa bắt buộc tới khi FE gửi (21 §18.6.2)',
    }),
  })
  .meta({ id: 'ShopSetupInput' });

export const ShopSetupPreview = z
  .object({
    suggestions: z.array(
      z
        .object({
          externalSkuId: z.string(),
          title: z.string(),
          match: z.enum(['sku', 'name', 'none']).meta({ description: '`sku`: SKU trùng; `name`: tên giống từ 0.4; `none`: không tìm được (21 §18.7.5)' }),
          score: z.number().min(0).max(1).nullable().meta({ description: 'Độ giống tên, chỉ có khi `match = name`' }),
          variantId: z.uuid().nullable(),
          sku: z.string().nullable(),
          available: z.number().int().nullable(),
          platformStock: z.number().int(),
          imageUrl: z.string().nullable().meta({
            description:
              'URL ảnh đầu tiên của sản phẩm trên sàn, chỉ để hiện; null khi sàn không trả hoặc BE không đọc được (TikTok: quá 50 sản phẩm đọc chi tiết, Get Product lỗi). URL ảnh TikTok có thể hết hạn: không lưu (21 §18.7.5)',
          }),
          status: z.enum(['live', 'review', 'rejected', 'hold', 'inactive']).meta({
            description: 'Trạng thái sản phẩm trên sàn đã chuẩn hoá: `live` đang bán, `review` chờ sàn duyệt, `rejected` sàn từ chối, `hold` sàn khoá, `inactive` người bán tắt hoặc nháp (21 §18.7.5)',
          }),
        })
        .strict(),
    ),
    unmatchedRemote: z.number().int().meta({ description: 'Số dòng `match = none` (21 §18.7.5)' }),
    nameMatchSkipped: z.boolean().meta({
      description:
        '`true` khi BE bỏ ghép theo tên vì gian hàng quá lớn (số cặp SKU sàn chưa ghép × biến thể còn lại vượt 1.000.000, hoặc hơn 50.000 cặp qua ngưỡng) hoặc so tên quá 10 giây: dòng không trùng SKU đều `none`, người dùng tự chọn biến thể',
    }),
    proposedCutoffAt: iso.meta({ description: 'Mốc kéo đơn BE sẽ đặt nếu xác nhận ngay với `push`; FE chỉ hiện (21 §18.6.2, §18.7.6)' }),
    firstShopOfCompany: z.boolean().meta({
      description: 'Công ty chưa có gian hàng nào xong thiết lập (có mốc, không chờ kiểm kê). `true` thì chỉ chọn được `stocktake`',
    }),
  })
  .strict()
  .meta({ id: 'ShopSetupPreview' });

export const ShopSetupResult = z
  .object({
    shop: Shop,
    matched: z.number().int(),
    stocktakeNumber: z.string().nullable().meta({ description: 'Số phiếu kiểm kê đầu kỳ vừa lập khi `stocktake`; null với `push`' }),
  })
  .strict()
  .meta({ id: 'ShopSetupResult' });
