import { z } from 'zod';
import { ProblemDetailsSchema } from '../../../../shared/http/openapi.ts';
import { StatusChangeSchema } from '../../../../shared/http/status-change.ts';

// Sàn kiểm theo danh sách adapter đã đăng ký ở service (422 `marketplace_unsupported`, Documents/21 §18.4), không viết cứng ở đây.
export const PlatformParams = z.object({ platform: z.string().max(40) });

// Gian hàng đang kết nối lại (#398). Sai dạng, rỗng: 422 (rỗng mà coi là vắng thì đi đường cũ, ghi token cho seller sàn trả);
// của công ty khác hay sàn khác: 404 ở service (review #412).
const ReconnectShopId = z.uuid('Mã gian hàng không hợp lệ');

export const AuthorizeUrlQuery = z
  .object({
    shopId: ReconnectShopId.optional().meta({
      description: 'Gian hàng đang kết nối lại; FE gửi khi bấm Kết nối lại, không gửi khi Thêm gian hàng',
    }),
  })
  .meta({ id: 'ShopAuthorizeUrlQuery' });

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
    shopId: ReconnectShopId.optional().meta({
      description: 'Gian hàng đang kết nối lại bằng token; token của seller khác thì 409 `shop_mismatch` (#398)',
    }),
  })
  .meta({ id: 'ShopTokenInput', description: 'Token lấy trên console của sàn (shop thử không đi OAuth được)' });

export const DisconnectBody = z
  .object({
    version: z.number('Thiếu version').int().positive(),
    zeroStock: z.boolean().default(false).meta({ description: 'Đẩy tồn 0 cho listing còn trên sàn trước khi ngắt' }),
  })
  .meta({ id: 'ShopDisconnectInput' });

/** Xoá gian hàng đã ngắt (#398): gõ đúng `XOA` để chặn gọi nhầm từ script hay client khác, không chỉ dựa vào FE. */
export const ShopDeleteBody = z
  .object({
    confirm: z.literal('XOA', { error: 'Gõ đúng XOA để xác nhận xoá' }),
    version: z.number('Thiếu version').int().positive(),
  })
  .meta({ id: 'ShopDeleteInput' });


// Schema trả về: Swagger và test integration parse body bằng chính các schema này (Documents/21 §1.1).
const iso = z.iso.datetime();


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
    ordersPulledOkAt: iso.nullable().meta({ description: 'Giờ bắt đầu lượt lấy đơn gần nhất chạy xong trọn (#223)' }),
    ordersStale: z.boolean().meta({
      description:
        'Đơn chưa cập nhật (21 §18.6.6): mất uỷ quyền, hoặc 15 phút chưa có lượt lấy đơn chạy trọn. SKU bán ở gian hàng này tạm không đẩy tăng tồn trên mọi gian hàng; listing bị giữ có `stockSyncError.code = orders_stale`',
    }),
    orderPullError: z.string().nullable().meta({ description: 'Lỗi của lượt kéo đơn định kỳ gần nhất (`Kéo đơn lỗi: …`); null khi lượt sau chạy trọn' }),
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
          'Phiếu kiểm kê đầu kỳ đang chờ ghi sổ. Khác null: gian hàng `active` ở chế độ chờ kiểm kê lần đầu, không đẩy tồn, không giữ hàng, đẩy listing 409 `shop_awaiting_stocktake` (21 §18.6.2). `rejected`, `cancelled` giữ nguyên tới khi lập lại phiếu (18.6.11); phiếu không còn đọc được thì báo `cancelled`. Phiếu ghi sổ thì BE đặt `openingStocktake = null`, đổi `orderCutoffAt`, chạy lại lượt kéo đơn còn mở, rồi chờ phân hàng; nhận `fulfillment.allocation_done` có `cause` trùng phiếu mới bật cập nhật tồn (18.6.11)',
      }),
    setup: z
      .object({
        steps: z.array(
          z
            .object({
              key: z.enum(['match', 'opening_stock', 'open_orders', 'allocate', 'push_stock']),
              status: z.enum(['pending', 'running', 'done', 'failed', 'blocked']),
              blockedBy: z.string().nullable().meta({ description: 'Bước đang chặn (`opening_stock`, `open_orders`, `allocate`), xét theo thứ tự đó, hoặc mã issue chưa làm; null khi không `blocked`' }),
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
    categoryChangeIssues: z.number().int().meta({
      description:
        'Số listing của gian hàng có `categoryChange.status` là `failed` hoặc `mismatch` (21 §18.5, §18.7.2, commerio-backend#467); nhãn "Đổi category trên sàn chưa xong"',
    }),
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
    walletMismatch: z.boolean().meta({
      description: 'Lần đối soát `done` gần nhất có số của gian hàng ra lệch ví (`walletDiff` khác 0); gian hàng chưa có lần nào như vậy thì `false` (21 §21.3, commerio-backend#251)',
    }),
    walletDiff: z.string().nullable().meta({
      description: 'Số dư sàn báo trừ số dư theo sổ của lần đối soát đó, chuỗi thập phân; `null` khi chưa có lần `done` nào có số',
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

export const ShopDetail = Shop.extend({ statusHistory: z.array(StatusChangeSchema) }).meta({ id: 'ShopDetail' });

const count = z.number().int().min(0);

/** 200 của xoá gian hàng (#398): số dòng đã xoá theo nhóm để FE báo lại. */
export const ShopDeleteResult = z
  .object({
    deleted: z
      .object({
        orders: count,
        orderLines: count,
        returnRequests: count,
        returnRequestLines: count,
        packages: count,
        packageLines: count,
        returnParcels: count,
        listings: count,
        priceCalculations: count,
        rawOrders: count,
        remoteSkus: count,
        stockDocuments: count.meta({ description: 'Phiếu kho nháp, chờ duyệt của gian hàng' }),
        configVersions: count,
        orderSettlements: count,
        reportRows: count,
        messageChannels: count,
      })
      .strict(),
    detached: z
      .object({ stockDocuments: count.meta({ description: 'Phiếu kho đã ghi sổ (từ chối, huỷ) giữ lại, cắt `shop_id`, thêm ghi chú' }) })
      .strict(),
  })
  .strict()
  .meta({ id: 'ShopDeleteResult' });

/** Số dòng dữ liệu tiền theo nhóm, có nhóm > 0 thì không xoá được gian hàng (#398). */
export const FinanceDataCountsSchema = z
  .object({
    ledgerEntries: count,
    ledgerPackageLines: count,
    settlementStatements: count,
    settlementBatches: count,
    orderSettlements: count.meta({ description: 'Đối soát theo đơn khác `none`' }),
    documents: count.meta({ description: 'Hoá đơn, phiếu thu, phiếu chi của đơn gian hàng' }),
    payments: count.meta({ description: 'Trạng thái tiền, mã thanh toán, giao dịch cổng của đơn gian hàng' }),
  })
  .strict()
  .meta({ id: 'ShopFinanceData' });

/**
 * 409 của xoá gian hàng: `shop_not_disconnected`, `version_conflict` kèm `current`; `shop_has_finance_data` kèm
 * `financeData`; `shop_has_open_inspection` kèm `documents`.
 */
export const ShopDeleteConflict = ProblemDetailsSchema.extend({
  current: Shop.optional().meta({ description: '`shop_not_disconnected`, `version_conflict`: gian hàng hiện tại' }),
  financeData: FinanceDataCountsSchema.optional().meta({ description: 'Chỉ có với `shop_has_finance_data`' }),
  documents: z
    .array(z.object({ id: z.uuid(), number: z.string() }).strict())
    .optional()
    .meta({ description: 'Chỉ có với `shop_has_open_inspection`: phiếu kiểm hàng hoàn chưa ghi sổ đã cộng chờ xử lý' }),
}).meta({ id: 'ShopDeleteConflict' });

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

// Listing (#104; Documents/21 §18.3, §18.4).
export const ListingParams = z.object({ id: z.string(), variantId: z.uuid('Biến thể không hợp lệ') });

export const PushBody = z
  .object({
    variantIds: z.array(z.uuid('Biến thể không hợp lệ')).min(1, 'Chọn ít nhất một biến thể').max(20, 'Tối đa 20 biến thể mỗi lần'),
    // `z.unknown()` không `.optional()` là trường bắt buộc (Zod ≥ 4.4). Nhận mọi giá trị để FE cũ không bị 422.
    imageUrls: z.unknown().optional().meta({
      deprecated: true,
      description: 'Bỏ qua từ commerio-backend#303: BE lấy ảnh catalog của sản phẩm (tối đa 8 ảnh đầu)',
    }),
  })
  .meta({ id: 'ListingPushInput' });

export const DelistBody = z.object({ version: z.number('Thiếu version').int().positive() }).meta({ id: 'ListingDelistInput' });
export const UpdateContentParams = z.object({ id: z.string(), listingId: z.string() });
export const UpdateContentBody = z
  .object({ version: z.number('Thiếu version').int().positive() })
  .meta({ id: 'ListingUpdateContentInput' });

const listingStatus = z.enum(['pushing', 'push_failed', 'under_review', 'rejected', 'live', 'hidden', 'platform_hold', 'delisted']);
const syncState = z.enum(['synced', 'pending', 'error']);
const syncError = z.object({ code: z.string(), message: z.string(), at: iso }).strict().nullable();

const pendingRevision = z
  .object({ status: z.enum(['auditing', 'failed']), rejectReason: z.string().nullable(), at: iso })
  .strict()
  .nullable()
  .meta({
    description:
      'Bản sửa nội dung chờ sàn duyệt trong lúc listing vẫn bán (21 §18.3, #293); `failed` kèm lý do sàn ghi. Null khi không có',
  });

const categoryChange = z
  .object({
    status: z.enum(['queued', 'failed', 'mismatch']),
    toCategoryId: z.string(),
    toCategoryPath: z.string().nullable(),
    code: z.string().nullable(),
    message: z.string().nullable(),
    attempts: z.number().int(),
    at: iso,
  })
  .strict()
  .nullable()
  .meta({
    id: 'ListingCategoryChange',
    description:
      'Lượt đổi category trên sàn (`apply-category`, 21 §18.5, commerio-backend#467): `queued` đã xếp việc, chưa xong (FE gọi lại như `pushing`); `failed` sàn từ chối hoặc hết lượt thử (`code` `marketplace_rejected`, `marketplace_unavailable`, `shop_not_connected`…, `message` là câu của sàn); `mismatch` sàn nhận nhưng đọc lại lệch SKU, giá, ảnh (`message` liệt kê). Sàn nhận và không lệch thì null (trạng thái duyệt ở `pendingRevision`); `failed`, `mismatch` giữ tới lần `apply-category` sau',
  });

const pendingMapping = z
  .object({
    variantId: z.uuid().nullable().meta({ description: 'Biến thể xin ghép; null là "không quản tồn"' }),
    externalSkuId: z
      .string()
      .nullable()
      .meta({ description: 'SKU sàn chờ ghép vào listing lỗi đẩy chưa có mã sàn (#346); null khi đổi ghép thường' }),
    requestedBy: z.object({ id: z.uuid(), name: z.string() }).strict(),
    requestedAt: iso,
  })
  .strict()
  .nullable()
  .meta({ description: 'Ghép chờ CEO duyệt (21 §18.6.5); null khi không có' });

export const ChannelListing = z
  .object({
    id: z.uuid(),
    externalProductId: z.string().nullable(),
    externalSkuId: z.string().nullable(),
    sellerSku: z.string().nullable(),
    status: listingStatus,
    rejectReason: z.string().nullable(),
    pushError: syncError.meta({
      description:
        'Lỗi của lượt đẩy (21 §18.6.4): `marketplace_rejected`, `marketplace_unavailable` (`message` là câu của sàn); `shop_not_eligible`, `listing_check_failed` (TikTok, kiểm trước khi tạo sản phẩm, #305); `shop_not_connected` (gian hàng ngắt khi việc chạy); `sku_exists_on_platform` (#399: SellerSku đã có trên sàn từ trước lượt đẩy, sản phẩm của người bán; dùng Ghép SKU); mã chặn theo dòng (`not_found`, `sku_not_ready`, `price_missing`…) khi dữ liệu đổi giữa lúc xếp việc và lúc chạy',
    }),
    pushAttempts: z.number().int().meta({ description: 'Số lần đã gọi sàn trong lượt đẩy hiện tại (đặt về 0 khi bấm đẩy)' }),
    hiddenBy: z.enum(['platform', 'zero_stock']).nullable(),
    stockSync: syncState,
    priceSync: syncState,
    platformStock: z.number().int().nullable(),
    stockSyncError: syncError.meta({ description: 'Lỗi lần đẩy tồn gần nhất của riêng SKU này; `message` là câu của sàn' }),
    priceSyncError: syncError,
    qcAlert: z.null().meta({ description: 'Cảnh báo QC của sàn; chưa đọc, luôn null' }),
    lastPushedAt: iso.nullable(),
    lastPushedPrice: z.number().int().nullable(),
    outsideChange: z
      .object({ kind: z.enum(['disabled', 'price_changed']), platformPrice: z.number().int().nullable(), detectedAt: iso })
      .nullable()
      .meta({
        description:
          'Sàn đổi listing ngoài app, listing dừng bán chờ CEO quyết (21 §18.3, #360). `platformPrice`: giá gốc đọc trên sàn khi `kind = price_changed`',
      }),
    pendingMapping,
    pendingRevision,
    contentSource: z.enum(['app', 'platform']).meta({
      description:
        'Ai tạo nội dung (tên, mô tả, ảnh) của sản phẩm trên sàn (#399): `app` do app đẩy tạo; `platform` do người bán tạo rồi ghép. Đẩy lại listing `platform` chỉ bật lại SKU và đẩy giá, tồn; ghi nội dung Commerio lên bằng `take-over-content` (CEO)',
    }),
    categoryChange,
    version: z.number().int(),
  })
  .strict()
  .meta({ id: 'ChannelListing' });

export const RemoteTitleChanged = z
  .object({
    from: z.string().meta({ description: 'Tên trên sàn lúc ghép (hoặc lần app đẩy, sửa nội dung, lần xác nhận gần nhất)' }),
    to: z.string().meta({ description: 'Tên trong bản sao SKU sàn hiện tại' }),
    fromEn: z.string().nullable().meta({ description: 'Tên tiếng Anh lúc ghép (Lazada `name_en`); null khi sàn không có' }),
    toEn: z.string().nullable().meta({ description: 'Tên tiếng Anh hiện tại; null khi sàn không có' }),
    detectedAt: iso.meta({ description: 'Lần đọc bản sao đầu tiên thấy tên khác' }),
  })
  .strict()
  .nullable()
  .meta({
    id: 'RemoteTitleChanged',
    description:
      'Tên trên sàn đã đổi ngoài app (#396, 21 §18.3): bản sao SKU sàn có (tên, tên tiếng Anh) khác lúc ghép. null khi không đổi. CEO xác nhận bằng `acknowledge-title`; đổi ghép, app đẩy, sửa nội dung cũng đặt lại mốc',
  });

export const RemoteSkusQuery = z.object({
  unmatched: z.stringbool().optional().meta({ description: '`true`: chỉ SKU sàn chưa ghép' }),
});

export const RemoteSkuList = z
  .object({
    items: z.array(
      z
        .object({
          externalProductId: z.string(),
          externalSkuId: z.string(),
          sellerSku: z.string(),
          title: z.string().meta({ description: 'Tên trên sàn người mua VN thấy (Lazada `attributes.name`)' }),
          titleEn: z
            .string()
            .nullable()
            .meta({ description: 'Tên tiếng Anh (Lazada `attributes.name_en`, Seller Center giao diện tiếng Anh hiện tên này); null khi sàn không có (#396)' }),
          matchedVariantId: z.uuid().nullable(),
          mode: z.enum(['mapped', 'unmanaged']).nullable().meta({ description: 'Ghép hiện hành; null khi chưa ghép (kể cả đang chờ CEO duyệt "không quản tồn")' }),
          listingId: z.uuid().nullable().meta({ description: 'Listing chưa gỡ của SKU sàn này (kể cả dòng chỉ chờ duyệt "không quản tồn"); null khi chưa có. CEO dùng để gọi `mapping/approve|reject`' }),
          listingVersion: z.number().int().nullable().meta({ description: '`version` của listing đó, gửi kèm khi duyệt; null khi chưa có listing' }),
          pendingMapping,
          remoteTitleChanged: RemoteTitleChanged,
        })
        .strict(),
    ),
    syncedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .meta({ description: 'Lần đọc trọn danh sách SKU của gian hàng gần nhất (bản sao BE lưu); null khi sàn chưa đọc được lần nào' }),
    refresh: z
      .object({
        status: z.enum(['idle', 'running', 'failed']).meta({
          description: '`running`: lượt tải nền đang chờ hoặc chạy (FE hỏi lại `GET` tới khi khác `running`); `failed`: lần đọc trọn lỗi gần nhất chưa quá 10 phút, hoặc lượt tải quá 15 phút chưa xong (`refresh_stale`)',
        }),
        requestedAt: z.iso.datetime({ offset: true }).nullable().meta({ description: 'Lúc xếp lượt tải đang chờ hoặc chạy; null khi không có' }),
        error: z
          .object({
            code: z.string().meta({ description: 'Mã lỗi app, vd `marketplace_rejected`, `marketplace_unavailable`, `shop_not_connected`, `refresh_stale`' }),
            platformCode: z.string().nullable().meta({ description: 'Mã của sàn, vd `incomplete_list`, `too_many_calls`, `daily_call_limit`' }),
            message: z.string(),
          })
          .strict()
          .nullable(),
        retryAfterSeconds: z.number().int().nullable().meta({ description: 'Số giây còn phải chờ trước khi Tải lại (lỗi đọc trọn); null khi bấm được ngay' }),
      })
      .strict()
      .meta({ id: 'RemoteSkuRefresh', description: 'Lượt Tải lại chạy nền (#361)' }),
  })
  .strict()
  .meta({ id: 'RemoteSkuList' });

export const MatchBody = z
  .object({
    externalSkuId: z.string('Thiếu SKU sàn').trim().min(1, 'Thiếu SKU sàn').max(200),
    variantId: z.uuid('Biến thể không hợp lệ').nullable().meta({ description: 'null là "không quản tồn" (cần CEO duyệt)' }),
  })
  .meta({ id: 'ListingMatchInput' });

export const MatchPreviewQuery = z.object({
  externalSkuId: z.string('Thiếu SKU sàn').trim().min(1, 'Thiếu SKU sàn').max(200),
  variantId: z.uuid('Biến thể không hợp lệ'),
});

const money = z.string().meta({ description: 'Chuỗi số VND' });
export const MatchPreview = z
  .object({
    platform: z
      .object({
        stock: z.number().int().meta({ description: 'Tồn trên sàn trong bản sao SKU sàn' }),
        price: money.nullable().meta({ description: 'Giá gốc trên sàn; null khi sàn không trả hoặc bản sao đọc trước #460 (bấm Tải lại)' }),
        syncedAt: z.iso.datetime({ offset: true }).meta({ description: 'Lần đọc thấy SKU này trên sàn gần nhất' }),
      })
      .strict(),
    app: z
      .object({
        stock: z.number().int().nullable().meta({ description: 'Số có thể bán; null khi SKU kho chưa có số (chưa nhập, chưa kiểm kê)' }),
        price: money.nullable().meta({ description: 'Giá đang bán sẽ đẩy; null khi chưa có giá chuẩn' }),
      })
      .strict(),
    stockWillPush: z.boolean(),
    stockHeldReason: z
      .enum(['shop_waiting_opening', 'not_counted'])
      .nullable()
      .meta({ description: '`shop_waiting_opening`: gian hàng chờ kiểm kê lần đầu; `not_counted`: SKU kho chưa có số, tồn trên sàn giữ nguyên' }),
    priceWillPush: z.boolean(),
  })
  .strict()
  .meta({ id: 'ListingMatchPreview' });

export const MappingParams = z.object({ id: z.string(), listingId: z.string(), action: z.enum(['approve', 'reject']) });

export const TakeOverContentParams = z.object({ id: z.string(), listingId: z.string() });
export const TakeOverContentBody = z
  .object({ version: z.number('Thiếu version').int().positive() })
  .meta({ id: 'ListingTakeOverContentInput' });

export const OutsideChangeParams = z.object({
  id: z.string(),
  listingId: z.string(),
  action: z.enum(['restore', 'accept-price']),
});

export const OutsideChangeBody = z
  .object({ version: z.number('Thiếu version').int().positive() })
  .meta({ id: 'ListingOutsideChangeDecisionInput' });

export const MappingBody = z
  .object({
    version: z.number('Thiếu version').int().positive(),
    reason: z.string().trim().max(500).optional(),
  })
  .meta({ id: 'ListingMappingDecisionInput' });

export const ListingRow = z
  .object({
    variantId: z.uuid(),
    productId: z.uuid(),
    productName: z.string(),
    sku: z.string(),
    attributesLabel: z.string(),
    thumbnailUrl: z.string().nullable().meta({ description: 'Ảnh đại diện catalog của sản phẩm; null khi sản phẩm chưa có ảnh (#303)' }),
    specStatus: z
      .enum(['complete', 'incomplete', 'missing'])
      .meta({ description: 'Spec của sản phẩm với sàn của gian hàng: chưa có (`missing`), còn thiếu (`incomplete`) (#400)' }),
    price: z.number().int().nullable().meta({ description: 'Giá đang bán: giá ghi đè tay, giá theo gian hàng đã xác nhận, hoặc giá chuẩn (#225)' }),
    priceSource: z.enum(['standard', 'shop', 'override']).nullable(),
    shopPrice: z.number().nullable().meta({ description: 'Giá theo bộ lọc giá của gian hàng đã xác nhận (Documents/25 §6.2); null khi chưa có' }),
    pendingPrice: z.number().nullable().meta({ description: 'Giá mới chờ xác nhận' }),
    configVersionId: z.uuid().nullable().meta({ description: 'Phiên bản phí sinh ra giá chờ xác nhận' }),
    netReceived: z.number().nullable().meta({ description: 'Thực nhận mỗi món theo giá đang bán; null khi gian hàng chưa có phí' }),
    belowFloor: z
      .boolean()
      .nullable()
      .meta({ description: 'Giá đang bán dưới giá thấp nhất; null khi chưa có giá vốn hoặc chưa có phí. Không kèm giá vốn (R4)' }),
    feeWarning: z.enum(['over_50']).nullable().meta({ description: 'Tổng phí và thuế của gian hàng trên 50%' }),
    listing: ChannelListing.nullable(),
    remoteTitleChanged: RemoteTitleChanged,
    externalCategoryId: z.string().nullable().meta({
      description: 'Category của listing trên sàn (`listings.external_category_id`, 21 §18.5, commerio-backend#467); null khi chưa có listing hoặc chưa biết category',
    }),
    externalCategoryPath: z.string().nullable().meta({
      description:
        'Đường dẫn của `externalCategoryId` của listing trong cây category đã đồng bộ (21 §18.5, commerio-backend#467); null khi chưa có listing, listing chưa có category hoặc category chưa có trong cây',
    }),
    categoryChange: categoryChange.meta({ description: 'Bằng `listing.categoryChange`; null khi chưa có listing (21 §18.5)' }),
  })
  .strict()
  .meta({ id: 'ListingRow' });

export const AcknowledgeTitleParams = z.object({ id: z.string(), listingId: z.string() });
export const AcknowledgeTitleBody = z
  .object({ version: z.number('Thiếu version').int().positive() })
  .meta({ id: 'ListingAcknowledgeTitleInput' });

export const ListingList = z.object({ items: z.array(ListingRow) }).strict().meta({ id: 'ListingList' });

/** Trang sản phẩm (21 §18.5 `GET /channel/products/:productId/listings`, #467). */
export const ProductListingsParams = z.object({ productId: z.string().max(60) });
export const ProductListingRow = ListingRow.extend({ shopId: z.uuid(), shopName: z.string(), platform: z.string() }).meta({ id: 'ProductListingRow' });
export const ProductListingList = z.object({ items: z.array(ProductListingRow) }).strict().meta({ id: 'ProductListingList' });

export const PushResult = z
  .object({
    variantId: z.string(),
    listingId: z.uuid().nullable().meta({ description: 'Listing được xếp việc hoặc listing hiện có của dòng bị chặn; null khi chưa có' }),
    status: listingStatus.nullable().meta({ description: '`pushing` khi đã xếp việc; dòng bị chặn: trạng thái listing hiện có' }),
    code: z.string().nullable().meta({
      description:
        'Null khi đã xếp việc. Dòng bị chặn: `not_found`, `push_in_progress`, `already_listed` (`under_review`, `live`, `hidden`), `mapping_pending` (listing lỗi đang chờ CEO duyệt ghép SKU sàn có sẵn), `sku_not_ready`, `price_missing`, `category_unmapped`, `dimensions_missing`, `images_missing`',
    }),
    message: z.string().nullable(),
  })
  .strict()
  .meta({ id: 'PushResult' });

export const PushResults = z.object({ results: z.array(PushResult) }).strict().meta({ id: 'PushResults' });

export const ListingSyncResult = z
  .object({
    queued: z.boolean().meta({ description: '`true`: vừa xếp một lượt đồng bộ; `false`: gian hàng đã có lượt chờ, không xếp thêm' }),
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
        'Hạn trả hàng (ngày, 1–60) khi `shop.capabilities.returnWindow = days`, bắt buộc với sàn này: thiếu hoặc `null` thì 422 (#362). Sàn `platform_status` bỏ qua và lưu null (21 §18.6.2)',
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

/** `POST /channel/shops/:id/opening-stocktake` (Documents/21 §18.6.11). */
export const OpeningStocktakeResult = z
  .object({
    shop: Shop,
    stocktakeNumber: z.string(),
  })
  .strict()
  .meta({ id: 'OpeningStocktakeResult' });

// Giá theo gian hàng (#225; Documents/21 §18.6.7, §21.4).
export const PendingPricesQuery = z.object({
  shopId: z.uuid('Gian hàng không hợp lệ').optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export const ListingIdParams = z.object({ id: z.string() });
export const ConfirmPriceBody = z.object({ version: z.number('Thiếu version').int().positive() }).meta({ id: 'ListingConfirmPriceInput' });
export const ManualPriceParams = z.object({ id: z.string(), listingId: z.string() });
export const ManualPriceBody = z
  .object({
    version: z.number('Thiếu version').int().positive(),
    price: z
      .number('Giá là số đồng')
      .int('Giá là số nguyên đồng')
      .positive('Giá phải lớn hơn 0')
      .max(1_000_000_000_000, 'Giá quá lớn')
      .nullable()
      .meta({ description: 'Giá ghi đè tay; null bỏ ghi đè' }),
  })
  .meta({ id: 'ListingManualPriceInput' });
export const PendingPrice = z
  .object({
    listing: ChannelListing,
    shopId: z.uuid(),
    variantId: z.uuid(),
    price: z.number().nullable().meta({ description: 'Giá đang bán (ghi đè, giá theo gian hàng đã xác nhận, hoặc giá chuẩn)' }),
    pendingPrice: z.number().meta({ description: 'Giá mới chờ xác nhận' }),
    netReceived: z.number().meta({ description: 'Thực nhận mỗi món theo giá chờ' }),
    belowFloor: z.boolean().nullable().meta({ description: 'Giá chờ dưới giá thấp nhất (không xác nhận được); null khi chưa có giá vốn' }),
    feeWarning: z.enum(['over_50']).nullable(),
    configVersionId: z.uuid().nullable().meta({ description: 'Phiên bản phí sinh ra giá chờ' }),
  })
  .strict()
  .meta({ id: 'PendingPrice' });
export const PendingPricePage = z
  .object({ items: z.array(PendingPrice), total: z.number().int(), page: z.number().int(), pageSize: z.number().int() })
  .strict()
  .meta({ id: 'PendingPricePage' });
export const UpdateShopBody = z
  .object({
    version: z.number('Thiếu version').int().positive(),
    returnWindowDays: z
      .number('Hạn trả hàng là số ngày')
      .int('Hạn trả hàng là số ngày nguyên')
      .min(1, 'Hạn trả hàng từ 1 đến 60 ngày')
      .max(60, 'Hạn trả hàng từ 1 đến 60 ngày')
      .meta({ description: 'Hạn trả hàng (ngày); chỉ sàn `capabilities.returnWindow = days` (#362)' }),
  })
  .strict()
  .meta({ id: 'ShopUpdateInput' });

// Category và attribute của sàn (#400, Documents/21 §18.5).
/** Mã category của Lazada, TikTok đều là số (gọi thật #400 G2.1); chặn chuỗi khác để không ghi dòng rác vào bảng chung. */
const categoryId = z.string().regex(/^\d{1,20}$/, 'Mã category không hợp lệ');
export const PlatformLeafParams = z.object({ platform: z.string().max(40), externalId: categoryId });
export const PlatformCategoriesQuery = z
  .object({
    search: z
      .string()
      .trim()
      .min(2, 'Nhập ít nhất 2 ký tự')
      .max(100)
      .optional()
      .meta({ description: 'Tìm leaf `active` theo đường dẫn (bỏ dấu); ưu tiên hơn `parentId`' }),
    parentId: categoryId.optional().meta({ description: 'Con trực tiếp; không gửi cả hai là cấp gốc' }),
  })
  .meta({ id: 'PlatformCategoriesQuery' });
export const LeafDetailQuery = z
  .object({
    shopId: z.uuid('Gian hàng không hợp lệ').optional().meta({ description: 'Gian hàng đang mở trang đẩy (sàn cần token, TikTok)' }),
  })
  .meta({ id: 'PlatformLeafQuery' });

const platformCategoryShape = {
  externalId: z.string(),
  parentExternalId: z.string().nullable(),
  name: z.string(),
  path: z.string().meta({ description: 'Tên từ gốc nối " > "' }),
  isLeaf: z.boolean(),
  status: z.enum(['active', 'removed']),
  pathIds: z.array(z.string()).meta({
    description:
      '`externalId` từ gốc tới chính category, cùng thứ tự với `path` (commerio-backend#467); đọc từ cây đã đồng bộ, cha chưa có trong cây thì thiếu phần gốc',
  }),
};
export const PlatformCategory = z.object(platformCategoryShape).strict().meta({ id: 'PlatformCategory' });
export const PlatformCategoryPage = z
  .object({
    items: z.array(PlatformCategory),
    syncedAt: iso.nullable().meta({ description: 'Lần đồng bộ cây gần nhất; null khi sàn chưa có dòng nào' }),
  })
  .strict()
  .meta({ id: 'PlatformCategoryPage' });

export const PlatformAttribute = z
  .object({
    code: z.string().meta({ description: 'Lazada `name`, TikTok id attribute' }),
    label: z.string(),
    kind: z.enum(['sales', 'property']),
    input: z.enum(['select', 'multiselect', 'text', 'number', 'date', 'image', 'cascade']),
    options: z.array(z.object({ id: z.string(), label: z.string() }).strict()),
    allowCustom: z.boolean().meta({ description: 'Được nhập giá trị ngoài `options`' }),
    required: z.boolean(),
    requiredWhen: z
      .array(z.object({ code: z.string(), optionIds: z.array(z.string()) }).strict())
      .nullable()
      .meta({ description: 'Bắt buộc khi attribute `code` có một trong `optionIds` (id lựa chọn)' }),
    isKey: z.boolean(),
    tier: z
      .enum(['category', 'product', 'company'])
      .meta({ description: '`product`: cột của catalog (xuất xứ, thương hiệu); `company`: hồ sơ công ty' }),
    defaultValue: z.string().nullable().meta({ description: 'Giá trị từ hồ sơ công ty cho `tier = company`; còn lại null' }),
  })
  .strict()
  .meta({ id: 'PlatformAttribute' });

export const PlatformLeafDetail = z
  .object({
    category: z.object({ ...platformCategoryShape, sizeChartRule: z.enum(['required', 'optional', 'unsupported']).nullable() }).strict(),
    attributes: z.array(PlatformAttribute),
    fetchedAt: iso.nullable().meta({ description: 'Lúc lấy attribute từ sàn; quá 7 ngày thì lần mở sau lấy lại' }),
    stale: z.boolean().meta({ description: 'Sàn lỗi (hoặc không có gian hàng để gọi) nên trả bản cũ' }),
    products: z
      .array(z.object({ productId: z.uuid(), code: z.string(), name: z.string(), source: z.enum(['push', 'match']) }).strict())
      .meta({ description: 'Sản phẩm của công ty có spec trỏ tới leaf, tối đa 200 dòng (cũ trước)' }),
  })
  .strict()
  .meta({ id: 'PlatformLeafDetail' });

export const CategorySyncResult = z
  .object({ queued: z.boolean().meta({ description: 'false khi sàn đã có lượt chờ' }) })
  .strict()
  .meta({ id: 'CategorySyncResult' });

// Spec sàn của sản phẩm (#400 lát 8, Documents/21 §18.5).
export const ProductSpecParams = z.object({ productId: z.string().max(60), platform: z.string().max(40) });
const specValue = z.union([z.string().trim().max(500), z.array(z.string().trim().max(500)).max(50)]);
export const ProductSpecBody = z
  .object({
    externalCategoryId: z.string('Chọn category của sàn').trim().min(1, 'Chọn category của sàn').max(40),
    attributes: z.record(z.string().max(60), specValue).default({}),
    axisMap: z.record(z.string().max(60), z.string().max(60)).default({}),
    valueMap: z.record(z.string().max(60), z.string().max(60)).default({}),
    version: z.number().int().nonnegative().nullable().meta({ description: 'null khi tạo mới' }),
  })
  .meta({ id: 'ProductSpecInput' });
export const ProductSpecSchema = z
  .object({
    productId: z.uuid(),
    platform: z.string(),
    externalCategoryId: z.string(),
    categoryPath: z.string().nullable(),
    categoryStatus: z.enum(['ok', 'changed', 'removed']),
    attributes: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
    axisMap: z.record(z.string(), z.string()),
    valueMap: z.record(z.string(), z.string()),
    source: z.enum(['push', 'match']),
    version: z.number().int().meta({ description: '0 là bản chép từ ghép danh mục, chưa ai lưu lại' }),
    updatedAt: iso,
  })
  .strict()
  .meta({ id: 'ProductSpec' });
export const ProductSpecView = z
  .object({
    spec: ProductSpecSchema.nullable(),
    missing: z.array(
      z
        .object({
          code: z.string(),
          label: z.string(),
          reason: z.enum(['required', 'required_when', 'axis_unmapped', 'category_changed', 'category_removed']),
        })
        .strict(),
    ),
  })
  .strict()
  .meta({ id: 'ProductSpecView' });

// Đổi category trên sàn (commerio-backend#467, 21 §18.5).
export const ApplyCategoryBody = z
  .object({ version: z.number('Thiếu version').int().nonnegative().meta({ description: '`version` của spec' }) })
  .meta({ id: 'ApplyCategoryInput' });
export const ApplyCategoryResult = z
  .object({
    items: z.array(
      z
        .object({
          shopId: z.uuid(),
          shopName: z.string(),
          externalProductId: z.string(),
          listingIds: z.array(z.uuid()),
          fromCategoryId: z.string().nullable().meta({ description: 'Category hiện tại trên sàn; null khi chưa biết' }),
          fromCategoryPath: z.string().nullable(),
          toCategoryId: z.string(),
          toCategoryPath: z.string().nullable(),
          code: z
            .enum(['shop_not_connected'])
            .nullable()
            .meta({ description: 'null là đã xếp việc; `shop_not_connected`: gian hàng không `active` hoặc hết token, không xếp' }),
        })
        .strict(),
    ),
  })
  .strict()
  .meta({ id: 'ApplyCategoryResult' });

// Cấp kế của attribute cascade (#400, Documents/21 §18.5).
export const CascadeQuery = z.object({
  code: z.string('Chọn attribute').trim().min(1, 'Chọn attribute').max(60),
  path: z.string().trim().max(2000).optional(),
  shopId: z.uuid('Gian hàng không hợp lệ').optional(),
});
export const CascadeLevelSchema = z
  .object({
    prop: z.object({ id: z.string(), label: z.string(), required: z.boolean() }).strict().nullable(),
    items: z.array(z.object({ id: z.string(), label: z.string(), leaf: z.boolean() }).strict()),
  })
  .strict()
  .meta({ id: 'CascadeLevel' });

// Gợi ý category của sàn theo sản phẩm (#400 lát 9, Documents/21 §18.5).
export const ShopWarehousesView = z
  .object({
    items: z.array(
      z
        .object({
          code: z.string(),
          name: z.string(),
          address: z.string().nullable(),
          kind: z.enum(['sales', 'return']).meta({ description: 'Kho bán hàng hay kho nhận hàng trả' }),
          isDefault: z.boolean().meta({ description: 'Sàn đánh dấu kho mặc định' }),
          managed: z.boolean().meta({ description: 'Kho app quản: app chỉ đọc, đẩy tồn và nhận món của kho này (#430)' }),
        })
        .strict(),
    ),
  })
  .strict()
  .meta({ id: 'ShopWarehouses' });

export const CategorySuggestionsQuery = z.object({
  productId: z.string('Chọn sản phẩm').trim().min(1, 'Chọn sản phẩm').max(60),
});
export const CategorySuggestionsView = z
  .object({
    items: z.array(
      z
        .object({
          externalId: z.string(),
          path: z.string(),
          permission: z.enum(['available', 'invite_only', 'non_main_category', 'prohibited']).nullable(),
        })
        .strict(),
    ),
    cached: z.boolean(),
  })
  .strict()
  .meta({ id: 'CategorySuggestions' });

// "Đồng bộ ngay" cây category (#400, Thành chốt 19/11/2026): `allowShrink` chỉ quản trị nền tảng.
export const CategorySyncBody = z
  .object({
    allowShrink: z
      .boolean('allowShrink phải là true hoặc false')
      .optional()
      .meta({ description: 'Cho lượt này ghi cả khi cây sàn trả thiếu quá ngưỡng (đánh `removed` hàng loạt). Chỉ quản trị nền tảng' }),
  })
  .default({})
  .meta({ id: 'CategorySyncInput' });
