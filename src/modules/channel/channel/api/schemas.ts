import { z } from 'zod';
import { ProblemDetailsSchema } from '../../../../shared/http/openapi.ts';
import { StatusChangeSchema } from '../../../../shared/http/status-change.ts';
import { MISSING_REASONS, PLATFORM_KINDS } from '../domain/product-spec.ts';

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
      .meta({ description: 'Mọi query trên URL callback trừ `state`; adapter của sàn tự đọc' }),
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
    productSpec: z.boolean().meta({ description: 'Sàn có cây category và attribute: có thông tin sàn của sản phẩm, trang đẩy theo spec' }),
    contentUpdate: z.boolean().meta({ description: 'Sửa được nội dung listing đang bán (§18.3)' }),
    repackOnReopen: z.boolean().meta({ description: 'Mở kiện đã đóng gói thì sàn huỷ mã kiện cũ; đóng gói lại ra mã kiện, mã vận đơn mới' }),
  })
  .strict()
  .meta({ id: 'ShopCapabilities', description: 'Năng lực sàn do adapter khai (Documents/21 §18.6.3); FE rẽ nhánh theo đây, không theo mã sàn' });

export const Shop = z
  .object({
    id: z.uuid(),
    companyId: z.uuid(),
    platform: z.string().meta({ description: 'Mã sàn (`ShopPlatform.platform`)' }),
    externalShopId: z.string().meta({ description: 'Mã gian hàng (người bán) phía sàn' }),
    shopName: z.string(),
    displayName: z.string().nullable().meta({ description: 'Tên người dùng đặt (1–60 ký tự); null thì hiện `shopName` (#565)' }),
    region: z.string().nullable(),
    status: z.enum(['connecting', 'active', 'needs_reauth', 'disconnected']),
    accessExpiresAt: iso.nullable(),
    refreshExpiresAt: iso.nullable(),
    authExpiresAt: iso
      .nullable()
      .meta({ description: 'Hạn uỷ quyền seller chọn trên sàn; null khi sàn không có hạn riêng ngoài refreshExpiresAt' }),
    tokenExpiringSoon: z
      .boolean()
      .meta({ description: 'Đang active và hạn gần hơn trong authExpiresAt, refreshExpiresAt còn dưới 3 ngày' }),
    lastOrderSyncAt: iso.nullable(),
    orderCutoffAt: iso.nullable().meta({ description: 'Mốc kéo đơn, null khi chưa thiết lập' }),
    ordersPulledOkAt: iso.nullable().meta({ description: 'Giờ bắt đầu lượt lấy đơn gần nhất chạy xong trọn (#223)' }),
    openOrdersPulledAt: iso.nullable().meta({ description: 'Lượt kéo đơn còn mở sau thiết lập đã xong; null khi chưa xong (#198)' }),
    unlinkedSkuCount: z.number().int().meta({ description: 'Số SKU sàn chưa liên kết, không tính SKU chờ CEO duyệt (#565)' }),
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
        'Số sản phẩm người bán có trên sàn lúc nối, không tính sản phẩm đã xoá trên sàn. Nghĩa cố định cho mọi sàn, sàn nào cũng trả; BE lấy bằng tổng sàn trả sẵn, không đọc hết danh sách. `null` chỉ khi BE chưa đọc được: adapter của sàn chưa có cách đếm, sàn lỗi (kể cả hết hạn mức gọi, sàn không trả lời) hoặc quá 10 giây. BE không trả 0 thay cho lỗi; việc nối vẫn xong (21 §18.7.4)',
    }),
    remoteSkuCount: z.number().int().nullable().meta({
      description:
        'Số phân loại người bán có trên sàn lúc nối. Phân loại là SKU của sàn; sản phẩm không chia phân loại tính là 1. Không tính phân loại của sản phẩm đã xoá. Nghĩa cố định cho mọi sàn. `null` khi BE chưa biết: sàn không trả tổng số phân loại và BE chưa đọc hết danh sách (adapter khai theo sàn), hoặc khi `remoteProductCount` là `null`. BE không suy số phân loại từ số sản phẩm (21 §18.7.4)',
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
    listPrices: z
      .record(z.string(), z.number('Giá là số đồng').int('Giá là số nguyên đồng').positive('Giá phải lớn hơn 0'))
      .optional()
      .meta({ description: 'Giá niêm yết người bán gõ theo biến thể (21 §18.9 R1): lưu thành giá ghi đè tay, kiểm giá thấp nhất từng dòng' }),
  })
  .superRefine((body, ctx) => {
    const ids = new Set(body.variantIds);
    for (const id of Object.keys(body.listPrices ?? {})) {
      if (!ids.has(id)) ctx.addIssue({ code: 'custom', path: ['listPrices', id], message: 'Biến thể không nằm trong lần đăng này' });
    }
  })
  .meta({ id: 'ListingPushInput' });

export const PriceQuoteParams = z.object({ productId: z.string().max(60) });
export const PriceQuoteBody = z
  .object({
    items: z
      .array(
        z.object({
          shopId: z.string().max(60),
          variantId: z.string().max(60),
          listPrice: z.number('Giá là số đồng').int('Giá là số nguyên đồng').positive('Giá phải lớn hơn 0').optional(),
        }),
      )
      .min(1, 'Cần ít nhất một dòng')
      .max(200, 'Tối đa 200 dòng'),
  })
  .meta({ id: 'PriceQuoteInput' });
/** Quy tắc làm tròn đã áp cho giá bộ lọc (21 §18.11, be#566). */
export const PriceRounding = z
  .object({
    step: z.number().int().meta({ description: 'Bậc làm tròn lên (đồng) của cấu hình phí đang áp' }),
    ending: z.number().int().nullable().meta({ description: 'Đuôi giá; null khi đuôi 0' }),
    before: z.number().int().meta({ description: 'Giá sau khi bù phí, trước khi làm tròn (làm tròn tới đồng)' }),
    after: z.number().int().meta({ description: 'Giá niêm yết sau khi làm tròn' }),
  })
  .strict()
  .meta({ id: 'PriceRounding' });
const rounding = PriceRounding.nullable().meta({ description: 'null khi giá gõ tay hoặc không tính bằng bộ lọc giá (21 §18.11)' });
export const PriceQuote = z
  .object({
    shopId: z.string(),
    variantId: z.string(),
    listPrice: z.number().nullable(),
    netReceived: z.number().nullable(),
    belowFloor: z.boolean().nullable().meta({ description: 'null khi người gọi thiếu `inventory.cost.view` (R4: dò giá thấp nhất suy ra giá vốn), chưa có giá vốn, hoặc dòng bị chặn' }),
    feeWarning: z.enum(['over_50']).nullable(),
    rounding,
    feeConfigId: z.string().nullable(),
    blocked: z.object({ code: z.enum(['price_missing', 'fee_config_invalid', 'fee_not_configured']) }).nullable(),
    marginPct: z.number().nullable().meta({ description: 'null khi người gọi thiếu `inventory.cost.view` (R4) hoặc chưa có giá vốn' }),
  })
  .strict()
  .meta({ id: 'PriceQuote' });
export const PriceQuoteList = z.object({ items: z.array(PriceQuote) }).strict().meta({ id: 'PriceQuoteList' });

export const DelistBody = z.object({ version: z.number('Thiếu version').int().positive() }).meta({ id: 'ListingDelistInput' });
export const UpdateContentParams = z.object({ id: z.string(), listingId: z.string() });
export const UpdateContentBody = z
  .object({ version: z.number('Thiếu version').int().positive() })
  .meta({ id: 'ListingUpdateContentInput' });

const listingStatus = z.enum(['pushing', 'push_failed', 'under_review', 'rejected', 'live', 'hidden', 'platform_hold', 'delisted']);
const syncState = z.enum(['synced', 'pending', 'error']);

/** Chỗ sửa của mục chặn (21 §18.10 `BlockerTarget`, cộng `listing` của 18.11; kiểu ở `domain/blocker.ts`). */
export const BlockerTarget = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('category') }).strict(),
    z.object({ kind: z.literal('spec_attribute'), attributeCode: z.string() }).strict(),
    z.object({ kind: z.literal('axis'), attributeId: z.string().optional() }).strict(),
    z.object({ kind: z.literal('variant_field'), field: z.enum(['price', 'weight', 'dimensions']) }).strict(),
    z.object({ kind: z.literal('product_field'), field: z.enum(['images', 'variantImages', 'sizeChart', 'name']) }).strict(),
    z.object({ kind: z.literal('shop'), field: z.enum(['fee_config', 'category_permission']) }).strict(),
    z.object({ kind: z.literal('platform_product'), externalProductIds: z.array(z.string()) }).strict(),
    z.object({ kind: z.literal('listing'), listingId: z.uuid().nullable() }).strict(),
  ])
  .meta({ id: 'BlockerTarget' });

/** Lỗi lượt đẩy đã dịch (#567, 21 §18.6.4 "Dịch lỗi đẩy của sàn"); bản ghi trước #567 trả `null` ở các trường mới. */
const pushError = z
  .object({
    code: z.string(),
    kind: z.enum(['data', 'platform', 'connection']).nullable(),
    message: z.string(),
    target: BlockerTarget.nullable(),
    variantId: z.string().nullable(),
    platformCode: z.string().nullable(),
    platformMessage: z.string().nullable(),
    requestId: z.string().nullable(),
    at: iso,
  })
  .strict()
  .nullable();

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
    pushError: pushError.meta({
      description:
        'Lỗi của lượt đẩy (21 §18.6.4). `code` là mã đã dịch: mã của bảng dịch sàn (`attribute_value_invalid`, `weight_out_of_range`, `attribute_required`, `axis_unmapped`, `images_missing`, `image_rejected`, `category_not_leaf`, `name_length`, `variant_images_missing`), không dịch được thì `marketplace_rejected`; lỗi tạm `marketplace_unavailable`; `shop_not_eligible`, `listing_check_failed` (#305); `shop_not_connected`; `sku_exists_on_platform` (#399); mã chặn theo dòng khi dữ liệu đổi giữa lúc xếp việc và lúc chạy. `message` là câu tiếng Việt cho người bán. `kind`: `data` (sửa được trong app), `platform` (sàn từ chối vì lý do ngoài dữ liệu), `connection` (lỗi tạm). `target` chỉ chỗ sửa (`BlockerTarget`), null khi không suy được. `platformCode`, `platformMessage` là mã và câu gốc của sàn (Lazada lấy từ `detail`), `requestId` của sàn. Lỗi ghi trước #567 có `kind`, `target`, `variantId`, `platformCode`, `platformMessage`, `requestId` là null',
    }),
    pushAttempts: z.number().int().meta({ description: 'Số lần đã gọi sàn trong lượt đẩy hiện tại (đặt về 0 khi bấm đẩy)' }),
    hiddenBy: z.enum(['platform', 'zero_stock']).nullable(),
    stockSync: syncState,
    priceSync: syncState,
    platformStock: z.number().int().nullable(),
    stockSyncError: pushError.meta({
      description:
        'Lỗi lần đẩy tồn gần nhất của riêng SKU này, cùng hình `pushError` (#571, 21 §18.6.4). Lỗi sàn: `code` đã dịch bằng bảng dịch của sàn (`promotion_locked`, `semi_hosted_product`…), không dịch được thì `marketplace_rejected`; `message` là câu tiếng Việt, mã và câu gốc ở `platformCode`, `platformMessage`. Lỗi do app giữ (`stock_not_counted`, `orders_stale`, `variant_missing`, `promotion_locked` đọc trước khi đẩy) có `kind`, `target`, `platformCode`, `platformMessage`, `requestId` null',
    }),
    priceSyncError: pushError.meta({
      description: 'Lỗi lần đẩy giá gần nhất, cùng hình `stockSyncError` (`price_invalid` chỉ ô giá; `price_missing` do app giữ)',
    }),
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
    fromEn: z.string().nullable().meta({ description: 'Tên tiếng Anh lúc ghép; null khi sàn không có' }),
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
          title: z.string().meta({ description: 'Tên trên sàn người mua VN thấy' }),
          titleEn: z
            .string()
            .nullable()
            .meta({ description: 'Tên tiếng Anh (Seller Center giao diện tiếng Anh hiện tên này); null khi sàn không có (#396)' }),
          matchedVariantId: z.uuid().nullable(),
          mode: z.enum(['mapped', 'unmanaged']).nullable().meta({ description: 'Ghép hiện hành; null khi chưa ghép (kể cả đang chờ CEO duyệt "không quản tồn")' }),
          listingId: z.uuid().nullable().meta({ description: 'Listing chưa gỡ của SKU sàn này (kể cả dòng chỉ chờ duyệt "không quản tồn"); null khi chưa có. CEO dùng để gọi `mapping/approve|reject`' }),
          listingVersion: z.number().int().nullable().meta({ description: '`version` của listing đó, gửi kèm khi duyệt; null khi chưa có listing' }),
          pendingMapping,
          remoteTitleChanged: RemoteTitleChanged,
          suggestion: z
            .object({
              variantId: z.uuid(),
              sku: z.string(),
              productName: z.string(),
              match: z.enum(['sku', 'name']).meta({ description: '`name` chỉ là đoán, FE không tự chọn sẵn; liên kết hàng loạt chỉ gom cặp `sku`' }),
              score: z.number().min(0).max(1).nullable().meta({ description: 'Độ giống tên 0..1, chỉ khi `match = name`' }),
            })
            .strict()
            .nullable()
            .meta({ description: 'Gợi ý liên kết, cùng lõi với `/setup` (21 §18.9 R2); null khi SKU sàn đã có listing hoặc không tìm được' }),
          canCreate: z.boolean().meta({ description: 'Tạo được SKU kho từ SKU sàn này (`create-variant`)' }),
          cannotCreateReason: z
            .enum(['no_seller_sku', 'sku_too_long', 'sku_taken', 'no_permission', 'already_matched'])
            .nullable()
            .meta({ description: 'Có khi và chỉ khi `canCreate = false`; `already_matched`: SKU sàn đã có listing (đã liên kết hoặc chờ duyệt)' }),
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

// ---- Liên kết SKU sàn gom theo sản phẩm sàn (#565, Documents/21 §18.12) ----

/** Lượt Tải lại chạy nền (#361), dùng chung cho `remote-skus` và `remote-products`. */
const RemoteSkuRefresh = RemoteSkuList.shape.refresh;

export const RemoteProductsQuery = z.object({
  status: z.enum(['unlinked', 'linked', 'pending', 'all']).default('unlinked').meta({
    description:
      '`unlinked`: SKU chưa có listing chưa gỡ và không chờ duyệt; `linked`: có listing chưa gỡ (`mapped`, hoặc `unmanaged` đã duyệt); `pending`: chỉ có yêu cầu chờ CEO duyệt',
  }),
  search: z
    .string()
    .trim()
    .max(200, 'Tối đa 200 ký tự')
    .refine((s) => s.length === 0 || s.length >= 2, 'Nhập ít nhất 2 ký tự')
    .optional()
    .meta({ description: 'Tên (cả tên tiếng Anh), SKU người bán, mã SKU sàn, mã sản phẩm sàn; bỏ dấu, không phân biệt hoa thường' }),
  decision: z
    .enum(['create', 'link', 'skip', 'unmanaged', 'none'])
    .optional()
    .meta({ description: 'Chỉ gian hàng `connecting` (lọc theo nháp thiết lập, be#569); gian hàng khác bỏ qua' }),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50, 'Tối đa 50 sản phẩm mỗi trang').default(20),
});

const RemoteSkuRowSchema = z
  .object({
    externalSkuId: z.string(),
    sellerSku: z.string(),
    title: z.string().meta({ description: 'Tên SKU trên sàn người mua VN thấy' }),
    titleEn: z.string().nullable().meta({ description: 'Tên tiếng Anh; null khi sàn không có (#396)' }),
    variantLabel: z.string().nullable().meta({ description: 'Nhãn biến thể sàn trả (giá trị thuộc tính bán, vd "Đỏ, M"); null khi sàn không có' }),
    platformStock: z.number().int().meta({ description: 'Tồn trên sàn theo bản sao' }),
    matchedVariantId: z.uuid().nullable(),
    mode: z.enum(['mapped', 'unmanaged']).nullable().meta({ description: 'Ghép hiện hành; null khi chưa ghép (kể cả đang chờ CEO duyệt "không quản tồn")' }),
    listingId: z.uuid().nullable().meta({ description: 'Listing chưa gỡ của SKU sàn này (kể cả dòng chỉ chờ duyệt); CEO dùng để gọi `mapping/approve|reject`' }),
    listingVersion: z.number().int().nullable(),
    pendingMapping,
    remoteTitleChanged: RemoteTitleChanged,
    suggestion: z
      .object({
        variantId: z.uuid(),
        sku: z.string(),
        productName: z.string(),
        match: z.enum(['sku', 'name']),
        score: z.number().min(0).max(1).nullable().meta({ description: 'Độ giống tên 0..1, chỉ khi `match = name`' }),
        confidence: z.enum(['high', 'medium', 'low']).meta({ description: '`high`: trùng SKU người bán; `medium`: tên giống từ 0,7; `low`: dưới 0,7' }),
      })
      .strict()
      .nullable()
      .meta({ description: 'Gợi ý liên kết cho SKU `unlinked` của trang; FE không tự chọn sẵn gợi ý `name`' }),
    canCreate: z.boolean(),
    cannotCreateReason: z.enum(['no_seller_sku', 'sku_too_long', 'sku_taken', 'no_permission', 'already_matched']).nullable(),
    decision: z
      .object({ action: z.enum(['link', 'create', 'skip', 'unmanaged']), variantId: z.uuid().nullable(), groupId: z.uuid().nullable() })
      .strict()
      .nullable()
      .meta({ description: 'Lựa chọn trong nháp thiết lập; chỉ gian hàng `connecting`' }),
  })
  .strict()
  .meta({ id: 'RemoteSkuRow' });

export const RemoteProductList = z
  .object({
    items: z.array(
      z
        .object({
          externalProductId: z.string(),
          title: z.string().meta({ description: 'Tên sản phẩm sàn (theo SKU đầu, bỏ phần nhãn biến thể)' }),
          titleEn: z.string().nullable(),
          imageUrl: z.string().nullable().meta({ description: 'Ảnh sản phẩm trên sàn; null khi sàn chưa trả' }),
          externalCategoryId: z.string().nullable().meta({ description: 'Category lá trên sàn; null khi sàn chưa trả' }),
          suggestedGroupId: z.uuid().nullable().meta({ description: 'Danh mục gợi ý; null tới khi có bảng ánh xạ category (be#569)' }),
          skus: z.array(RemoteSkuRowSchema),
        })
        .strict()
        .meta({ id: 'RemoteProduct' }),
    ),
    total: z.number().int().meta({ description: 'Số sản phẩm sàn khớp lọc' }),
    page: z.number().int(),
    pageSize: z.number().int(),
    counts: z
      .object({ unlinked: z.number().int(), linked: z.number().int(), pending: z.number().int() })
      .strict()
      .meta({ description: 'Số SKU của cả gian hàng theo trạng thái, không theo `search`' }),
    syncedAt: z.iso.datetime({ offset: true }).nullable(),
    refresh: RemoteSkuRefresh,
    nameMatchSkipped: z.boolean().meta({ description: 'Bỏ gợi ý theo tên vì quá nhiều cặp phải so hoặc quá giờ' }),
  })
  .strict()
  .meta({ id: 'RemoteProductList' });

export const SkuLinksBody = z
  .object({
    items: z
      .array(
        z.object({
          externalSkuId: z.string('Thiếu SKU sàn').trim().min(1, 'Thiếu SKU sàn').max(200),
          action: z.enum(['link', 'create', 'skip', 'unmanaged'], 'Thao tác không hợp lệ'),
          variantId: z.uuid('Biến thể không hợp lệ').nullable().optional(),
        }),
      )
      .max(200, 'Tối đa 200 SKU mỗi lần')
      .optional(),
    groups: z
      .array(z.object({ externalProductId: z.string('Thiếu sản phẩm sàn').trim().min(1).max(200), groupId: z.uuid('Chọn danh mục sản phẩm') }))
      .max(200, 'Tối đa 200 sản phẩm mỗi lần')
      .optional(),
    draftVersion: z.number().int().min(0).optional().meta({ description: 'Bắt buộc khi gian hàng `connecting`; gian hàng `active` bỏ qua' }),
  })
  .meta({ id: 'SkuLinksInput' });

export const SkuLinkResult = z
  .object({
    externalSkuId: z.string(),
    result: z.enum(['linked', 'pending', 'created', 'error']).meta({ description: '`pending`: chờ CEO duyệt; `created`: tạo SKU kho rồi liên kết' }),
    variantId: z.uuid().nullable(),
    productId: z.uuid().nullable(),
    code: z.string().nullable().meta({ description: 'Mã lỗi khi `error`' }),
    message: z.string().nullable(),
  })
  .strict()
  .meta({ id: 'SkuLinkResult' });
export const SkuLinksResult = z.object({ results: z.array(SkuLinkResult) }).strict().meta({ id: 'SkuLinksResult' });

export const MatchBody = z
  .object({
    externalSkuId: z.string('Thiếu SKU sàn').trim().min(1, 'Thiếu SKU sàn').max(200),
    variantId: z.uuid('Biến thể không hợp lệ').nullable().meta({ description: 'null là "không quản tồn" (cần CEO duyệt)' }),
  })
  .meta({ id: 'ListingMatchInput' });

export const MatchBulkBody = z
  .object({
    pairs: z
      .array(
        z.object({
          externalSkuId: z.string('Thiếu SKU sàn').trim().min(1, 'Thiếu SKU sàn').max(200),
          variantId: z.uuid('Biến thể không hợp lệ'),
        }),
      )
      .min(1, 'Chọn ít nhất một cặp')
      .max(100, 'Tối đa 100 cặp mỗi lần'),
  })
  .meta({ id: 'ListingMatchBulkInput' });
export const MatchBulkResult = z
  .object({
    results: z.array(
      z
        .object({
          externalSkuId: z.string(),
          variantId: z.uuid(),
          outcome: z.enum(['matched', 'pending', 'failed']).meta({ description: '`pending`: chờ CEO duyệt, như 202 của `listings/match`' }),
          code: z.string().nullable().meta({ description: 'Mã lỗi của `listings/match` khi `failed`' }),
          message: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict()
  .meta({ id: 'ListingMatchBulkResult' });
export const CreateVariantParams = z.object({ id: z.string(), externalSkuId: z.string().trim().min(1).max(200) });
export const CreateVariantBody = z.object({ groupId: z.uuid('Chọn danh mục sản phẩm') }).meta({ id: 'RemoteSkuCreateVariantInput' });
export const CreateVariantResult = z
  .object({
    variantId: z.uuid(),
    created: z.boolean().meta({ description: '`false`: SKU người bán trùng SKU kho có sẵn, liên kết vào SKU đó' }),
    pending: z.boolean().meta({ description: 'Liên kết chờ CEO duyệt (HTTP 202)' }),
    listing: ChannelListing,
  })
  .strict()
  .meta({ id: 'RemoteSkuCreateVariantResult' });

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
    fillBack: z
      .array(
        z
          .object({
            field: z.enum(['originCountry', 'brand', 'description', 'weight', 'dimensions', 'platformSpec']),
            value: z.string().nullable().meta({ description: 'Chữ hiển thị (tên nước, "250 g", "30 × 20 × 5 cm", đường dẫn category); null khi chưa đọc được sàn' }),
          })
          .strict(),
      )
      .meta({ description: 'Trường app đang trống mà liên kết sẽ điền từ sàn (21 §18.9 R4); `[]` khi không có gì để điền' }),
    fillBackError: z
      .object({ code: z.string(), message: z.string() })
      .strict()
      .nullable()
      .meta({ description: 'Không đọc được sản phẩm trên sàn; `fillBack` khi đó liệt kê trường app trống với `value` null, liên kết không bị chặn' }),
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
    rounding,
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
    stockToPush: z.number().int().nullable().meta({
      description: 'Số tồn lần đẩy tồn tới sẽ gửi cho SKU ở gian hàng này, cùng hàm với việc đẩy tồn, không gọi sàn; null khi chưa đẩy được tồn (21 §18.9 R3)',
    }),
    stockHeldReason: z.enum(['shop_waiting_opening', 'not_counted']).nullable().meta({
      description: 'Lý do chưa đẩy tồn, cùng nghĩa và thứ tự xét với `listings/match-preview`; khác null thì `stockToPush` null (21 §18.9 R3)',
    }),
    lastSyncFailedAt: iso.nullable().meta({
      description:
        'Giờ lần đẩy lỗi hoặc bị giữ gần nhất (`at` mới hơn của `stockSyncError`, `priceSyncError` còn hiệu lực); null khi không có lỗi. `listing.lastPushedAt` là lần thành công gần nhất (21 §18 "Kết quả lượt đồng bộ")',
    }),
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


export const Blocker = z
  .object({
    code: z.string().meta({ description: 'Mã chặn (21 §18.10 `Blocker.code`, cộng mã theo listing và gom biến thể của 18.11)' }),
    label: z.string().meta({ description: 'Câu cho người bán, BE dựng' }),
    scope: z.enum(['shop', 'platform', 'common']),
    target: BlockerTarget,
    variantIds: z.array(z.uuid()).meta({ description: 'Rỗng khi mục chặn cả sản phẩm' }),
  })
  .strict()
  .meta({ id: 'Blocker' });

export const ReadinessQuery = z.object({ shopId: z.uuid().optional() }).strict();

export const CategoryState = z
  .object({
    state: z.enum(['chosen', 'suggested', 'none']),
    externalCategoryId: z.string().nullable(),
    path: z.string().nullable(),
    source: z.enum(['push', 'match', 'group', 'recent']).nullable(),
    maxAxes: z.number().int().nullable().meta({ description: 'null khi attribute của leaf chưa lấy về' }),
    combinable: z.boolean().nullable().meta({ description: 'Leaf có đích ghép thuộc tính biến thể (18.8.3); null khi chưa biết' }),
  })
  .strict()
  .meta({ id: 'CategoryState' });

export const ShopReadiness = z
  .object({
    shopId: z.uuid(),
    shopName: z.string(),
    platform: z.string(),
    status: z.enum(['ready', 'blocked']),
    counts: z.object({ ready: z.number().int(), blocked: z.number().int(), listed: z.number().int() }).strict(),
    category: CategoryState,
    blockers: z.array(Blocker).meta({ description: 'Mỗi mục thiếu một phần tử; thứ tự: mục theo sàn, mục của SKU, mục của gian hàng' }),
    variants: z.array(
      z.object({ variantId: z.uuid(), status: z.enum(['ready', 'blocked', 'listed']), blockerCodes: z.array(z.string()) }).strict(),
    ),
  })
  .strict()
  .meta({ id: 'ShopReadiness' });

export const ProductReadiness = z.object({ items: z.array(ShopReadiness) }).strict().meta({ id: 'ProductReadiness' });

export const PushResult = z
  .object({
    variantId: z.string(),
    listingId: z.uuid().nullable().meta({ description: 'Listing được xếp việc hoặc listing hiện có của dòng bị chặn; null khi chưa có' }),
    status: listingStatus.nullable().meta({ description: '`pushing` khi đã xếp việc; dòng bị chặn: trạng thái listing hiện có' }),
    code: z.string().nullable().meta({
      description:
        'Null khi đã xếp việc. Dòng bị chặn: `not_found`, `push_in_progress`, `already_listed` (`under_review`, `live`, `hidden`), `mapping_pending` (listing lỗi đang chờ CEO duyệt ghép SKU sàn có sẵn), `fee_not_configured` (lần đăng đầu, đăng lại sau gỡ hay sau lỗi mà gian hàng chưa có cấu hình phí, kể cả giá gõ tay; Documents/21 §18.9 R5), `sku_not_ready`, `price_missing`, `category_unmapped`, `dimensions_missing`, `images_missing`',
    }),
    message: z.string().nullable(),
    blockers: z.array(Blocker).optional().meta({ description: 'Dòng bị chặn: mọi mục chặn kèm chỗ sửa (21 §18.10, §18.11); `code`, `message` là mục đầu' }),
  })
  .strict()
  .meta({ id: 'PushResult' });

export const PushResults = z.object({ results: z.array(PushResult) }).strict().meta({ id: 'PushResults' });

const variantIdList = z
  .array(z.uuid('Biến thể không hợp lệ'), 'Chọn ít nhất một biến thể')
  .min(1, 'Chọn ít nhất một biến thể')
  .max(200, 'Tối đa 200 biến thể mỗi lần xem trước');

/** Body của kiểm trước khi đăng hàng loạt (21 §18.11, be#566): như `push` nhưng tới 200 biến thể. */
export const PushPreviewBody = z
  .object({
    variantIds: variantIdList,
    listPrices: z
      .record(z.string(), z.number('Giá là số đồng').int('Giá là số nguyên đồng').positive('Giá phải lớn hơn 0'))
      .optional()
      .meta({ description: 'Giá niêm yết người bán gõ theo biến thể; không làm tròn (`rounding` null)' }),
  })
  .superRefine((body, ctx) => {
    const ids = new Set(body.variantIds);
    for (const id of Object.keys(body.listPrices ?? {})) {
      if (!ids.has(id)) ctx.addIssue({ code: 'custom', path: ['listPrices', id], message: 'Biến thể không nằm trong lần đăng này' });
    }
  })
  .meta({ id: 'ListingPushPreviewInput' });

export const PushPreviewRow = z
  .object({
    variantId: z.uuid(),
    productId: z.uuid(),
    productName: z.string(),
    attributesLabel: z.string(),
    sku: z.string(),
    status: z.enum(['ready', 'blocked']),
    blockers: z.array(Blocker).meta({
      description:
        'Cùng hàm với readiness (18.10) và `push`. Người gọi thiếu `inventory.cost.view` không nhận `below_floor` (lệnh đăng vẫn chặn)',
    }),
    listPrice: z.number().int().nullable().meta({ description: 'Giá lần đăng sẽ gửi (đã làm tròn); null khi chưa tính được' }),
    rounding,
    stockToPush: z.number().int().nullable(),
    stockHeldReason: z.enum(['shop_waiting_opening', 'not_counted']).nullable(),
    netReceived: z.number().nullable(),
    feePct: z.number().nullable().meta({ description: '(listPrice − netReceived) / listPrice' }),
    feeConfigId: z.string().nullable(),
  })
  .strict()
  .meta({ id: 'PushPreviewRow' });

export const PushPreview = z
  .object({ rows: z.array(PushPreviewRow), summary: z.object({ ready: z.number().int(), blocked: z.number().int() }).strict() })
  .strict()
  .meta({ id: 'PushPreview' });

export const ListingSyncResult = z
  .object({
    queued: z.boolean().meta({ description: '`true`: vừa xếp một lượt đồng bộ; `false`: gian hàng đã có lượt chờ, không xếp thêm' }),
    runId: z.uuid().meta({ description: 'Lượt người bấm; lượt `queued` đang có thì cùng id (21 §18 "Kết quả lượt đồng bộ")' }),
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
      .array(
        z
          .object({
            externalSkuId: z.string().trim().min(1).max(40),
            variantId: z.uuid().nullable(),
            create: z.boolean().optional().meta({
              description:
                '`true` là tạo SKU kho từ SKU sàn rồi ghép (#500), kèm `variantId: null`; cần `catalog.product.manage` (thiếu: 403) và `canCreate` của dòng (21 §18.7.5)',
            }),
          })
          .strict(),
      )
      .max(10_000)
      .optional()
      .meta({
        description:
          'Biến thể người dùng chọn cho từng SKU sàn, `null` là bỏ qua; SKU không có trong mảng cũng bỏ qua. Dòng sai: 422 `errors["decisions.<i>"]` (21 §18.7.5)',
      }),
    createGroupId: z
      .uuid('Chọn danh mục sản phẩm')
      .optional()
      .meta({ description: 'Danh mục sản phẩm cho sản phẩm tạo từ SKU sàn; bắt buộc khi có dòng `create` (#500, 21 §18.7.5)' }),
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
              'URL ảnh đầu tiên của sản phẩm trên sàn, chỉ để hiện; null khi sàn không trả hoặc BE không đọc được (vd quá 50 sản phẩm phải đọc chi tiết, đọc chi tiết lỗi). URL ảnh có thể hết hạn: không lưu (21 §18.7.5)',
          }),
          status: z.enum(['live', 'review', 'rejected', 'hold', 'inactive']).meta({
            description: 'Trạng thái sản phẩm trên sàn đã chuẩn hoá: `live` đang bán, `review` chờ sàn duyệt, `rejected` sàn từ chối, `hold` sàn khoá, `inactive` người bán tắt hoặc nháp (21 §18.7.5)',
          }),
          canCreate: z.boolean().meta({ description: 'Tạo được SKU kho từ SKU sàn này (#500, 21 §18.7.5)' }),
          cannotCreateReason: z.enum(['no_seller_sku', 'sku_too_long', 'sku_taken', 'no_permission']).nullable().meta({
            description:
              'Lý do không tạo được, có khi và chỉ khi `canCreate = false`: sàn chưa có SKU người bán, SKU quá 50 ký tự, SKU đã là SKU kho, thiếu `catalog.product.manage`',
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
    created: z.number().int().meta({ description: 'Số SKU kho vừa tạo từ SKU sàn (#500); đã tính trong `matched`' }),
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
      .optional()
      .meta({ description: 'Hạn trả hàng (ngày); chỉ sàn `capabilities.returnWindow = days` (#362). Bỏ trống là giữ' }),
    displayName: z
      .string('Tên gian hàng là chuỗi')
      .trim()
      .min(1, 'Tên gian hàng từ 1 đến 60 ký tự')
      .max(60, 'Tên gian hàng từ 1 đến 60 ký tự')
      .nullable()
      .optional()
      .meta({ description: 'Tên đặt riêng (#565, 21 §18.7.1); `null` bỏ tên riêng, hiện tên sàn; bỏ trống là giữ' }),
  })
  .strict()
  .refine((b) => b.returnWindowDays !== undefined || b.displayName !== undefined, {
    message: 'Chọn ít nhất một thông tin để sửa',
    path: ['returnWindowDays'],
  })
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
    shopId: z
      .uuid('Gian hàng không hợp lệ')
      .optional()
      .meta({ description: 'Gian hàng của công ty (đúng sàn, không thì 404): leaf kèm `permission` của gian hàng đó (#448)' }),
  })
  .meta({ id: 'PlatformCategoriesQuery' });
export const LeafDetailQuery = z
  .object({
    shopId: z.uuid('Gian hàng không hợp lệ').optional().meta({ description: 'Gian hàng đang mở trang đẩy (sàn cần token gian hàng)' }),
  })
  .meta({ id: 'PlatformLeafQuery' });

const MAX_AXES = z.number().int().min(0).nullable().meta({
  description: 'Số thuộc tính biến thể tối đa của leaf (21 §18.10, be#564); null khi không phải leaf, leaf chưa lấy attribute, hoặc sàn không khai',
});
const COMBINABLE = z.boolean().nullable().meta({ description: 'Leaf có đích ghép thuộc tính biến thể (21 §18.8.3, be#568); null khi chưa biết' });

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
  maxAxes: MAX_AXES,
  combinable: COMBINABLE,
};
export const PlatformCategory = z.object(platformCategoryShape).strict().meta({ id: 'PlatformCategory' });
export const PlatformCategoryPage = z
  .object({
    items: z.array(
      PlatformCategory.extend({
        permission: z
          .enum(['available', 'invite_only', 'non_main_category', 'prohibited'])
          .nullable()
          .optional()
          .meta({ description: 'Chỉ có khi gửi `shopId`; quyền của gian hàng với leaf (null: chưa kiểm, sàn không có quyền theo gian hàng, hoặc không phải leaf)' }),
      }).strict(),
    ),
    syncedAt: iso.nullable().meta({ description: 'Lần đồng bộ cây gần nhất; null khi sàn chưa có dòng nào' }),
  })
  .strict()
  .meta({ id: 'PlatformCategoryPage' });

export const PlatformAttribute = z
  .object({
    code: z.string().meta({ description: 'Mã attribute phía sàn' }),
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
export const ProductSpecQuery = z.object({
  categoryId: z.string().trim().min(1).max(60).optional().meta({ description: 'Leaf chưa lưu cần tính gợi ý ghép trục (#448); không gửi thì theo leaf của spec' }),
});
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
    fieldSources: z
      .record(z.string(), z.enum(['push', 'match', 'user']))
      .meta({ description: 'Nguồn từng attribute: đẩy (bản chép), đọc từ sàn khi ghép, người dùng sửa (#497)' }),
    version: z.number().int().meta({ description: '0 là bản chép từ ghép danh mục, chưa ai lưu lại' }),
    updatedAt: iso,
  })
  .strict()
  .meta({ id: 'ProductSpec' });
export const VariantCapabilitiesSchema = z
  .object({
    maxAxes: z.number().int().min(0),
    customAxisName: z.boolean().meta({ description: 'false: sàn từ chối tên trục tự đặt' }),
    salesRequired: z.array(z.string()).meta({ description: 'Sales attribute bắt buộc phải có trong `axisMap`' }),
    addVariant: z.boolean().meta({ description: 'true: thêm được phân loại vào sản phẩm sàn đã có; false thì SKU bị chặn ở lần đẩy đầu chặn cả cha (§18.8.4)' }),
    combineTarget: z.string().nullable().meta({
      description: 'Mã sales attribute BE đề xuất để ghép khi sản phẩm nhiều thuộc tính biến thể hơn `maxAxes`; null khi leaf không ghép được (#568)',
    }),
    maxValueLength: z.number().int().positive().nullable().meta({ description: 'Số ký tự tối đa của giá trị thuộc tính biến thể ghép; null: sàn không công bố' }),
    maxAxisValues: z.number().int().positive().nullable().meta({ description: 'Số giá trị tối đa của thuộc tính biến thể ghép; null: sàn không công bố' }),
  })
  .strict()
  .meta({ id: 'VariantCapabilities' });
export const ProductSpecView = z
  .object({
    spec: ProductSpecSchema.nullable(),
    resolved: z
      .record(
        z.string(),
        z
          .object({
            value: z.union([z.string(), z.array(z.string())]).meta({
              description: 'Select/multiselect: id lựa chọn của sàn khi khớp, nhãn khi tự gõ; text/number/date: chuỗi đã đổi sang định dạng gửi sàn',
            }),
            source: z.enum(['override', 'catalog', 'company', 'default']),
            fieldId: z.uuid().nullable().meta({ description: 'Thông số catalog đã điền ô này; null với nguồn khác và với thương hiệu, xuất xứ' }),
          })
          .strict(),
      )
      .meta({ description: 'Giá trị từng attribute sau khi áp ghi đè > thông số catalog > hồ sơ công ty > mặc định sàn (#509, Documents/21 §18.8.2). `{}` khi chưa có spec' }),
    suggestedAxisMap: z.record(z.string(), z.string()).nullable().meta({ description: 'attributeId → mã sales attribute hoặc `__custom`; null khi không có leaf hay chưa có attribute' }),
    suggestedValueMap: z.record(z.string(), z.string()).nullable().meta({ description: 'attributeValueId → mã lựa chọn của sales attribute' }),
    variantCapabilities: VariantCapabilitiesSchema.nullable(),
    missing: z.array(
      z
        .object({
          code: z.string(),
          label: z.string(),
          reason: z.enum(MISSING_REASONS),
        })
        .strict(),
    ),
    remote: z
      .object({
        shopId: z.uuid().nullable().meta({ description: 'null khi gian hàng đã xoá' }),
        shopName: z.string().nullable(),
        readAt: iso,
        originCountry: z.string().nullable().meta({ description: 'Mã ISO 3166-1 alpha-2' }),
        brand: z.string().nullable().meta({ description: 'null là sàn ghi không thương hiệu' }),
        description: z.string().nullable().meta({ description: 'Chữ trơn, đã bỏ HTML, tối đa 5000 ký tự' }),
        sizeChartUrl: z.string().nullable(),
        imageUrls: z.array(z.string()),
        variants: z.array(
          z
            .object({
              variantId: z.uuid(),
              weightG: z.number().int().nullable(),
              lengthMm: z.number().int().nullable(),
              widthMm: z.number().int().nullable(),
              heightMm: z.number().int().nullable(),
            })
            .strict(),
        ),
      })
      .strict()
      .nullable()
      .meta({ description: 'Bản sàn đang ghi ở lần đọc gần nhất khi ghép SKU (#497); null khi chưa đọc từ sàn' }),
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
const CATEGORY_PERMISSION = z.enum(['available', 'invite_only', 'non_main_category', 'prohibited']).nullable();
const UsedCategory = z
  .object({ externalId: z.string(), path: z.string(), productCount: z.number().int().min(1), permission: CATEGORY_PERMISSION, maxAxes: MAX_AXES, combinable: COMBINABLE })
  .strict();
export const CategorySuggestionsView = z
  .object({
    items: z.array(
      z
        .object({
          externalId: z.string(),
          path: z.string(),
          permission: CATEGORY_PERMISSION,
          usedByCompany: z.boolean().meta({ description: 'Công ty đã dùng category này trong spec của sản phẩm nào đó trên sàn' }),
          maxAxes: MAX_AXES,
          combinable: COMBINABLE,
        })
        .strict(),
    ),
    group: z.array(UsedCategory).max(5).meta({ description: 'Category của sản phẩm cùng danh mục sản phẩm trên sàn này, nhiều sản phẩm nhất trước (không đếm sản phẩm đang đẩy), tối đa 5' }),
    recent: z.array(UsedCategory).max(5).meta({ description: 'Category công ty dùng gần đây, bỏ phần đã ở items, group, tối đa 5' }),
    cached: z.boolean(),
    suggestError: z
      .object({
        code: z.enum(['product_name_too_short', 'images_missing', 'marketplace_unavailable']),
        message: z.string(),
        min: z.number().int().optional(),
      })
      .strict()
      .optional()
      .meta({ description: 'Không gọi được sàn: items rỗng, group và recent vẫn trả' }),
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
    shopId: z
      .uuid('shopId không hợp lệ')
      .optional()
      .meta({
        description:
          'Gian hàng đang thiết lập (#569): sàn cần token mà chưa có gian hàng `active` nào thì lượt mượn token của gian hàng này. Phải là gian hàng của công ty, cùng sàn; không thì 404',
      }),
  })
  .default({})
  .meta({ id: 'CategorySyncInput' });

// Ánh xạ trục phân loại sang sales attribute của sàn (#448, Documents/21 §18.8.1).
export const AxisMappingParams = z.object({ platform: z.string().max(40), attributeId: z.string().max(60) });
export const AxisMappingBody = z
  .object({
    codes: z
      .array(z.object({ attributeCode: z.string('Chọn mã thuộc tính').trim().min(1, 'Chọn mã thuộc tính').max(60) }).strict())
      .max(10, 'Tối đa 10 mã')
      .meta({ description: 'Thứ tự là `priority` (đầu tiên ưu tiên nhất); `[]` là bỏ ánh xạ' }),
  })
  .strict()
  .meta({ id: 'AxisMappingInput' });
const AXIS_KIND = z.enum(PLATFORM_KINDS).nullable();
const DATA_SCOPE = z.enum(['platform', 'company']).meta({ description: '`platform`: dữ liệu chuẩn dùng chung, ánh xạ do nền tảng giữ' });
export const AxisMappingItemSchema = z
  .object({
    attributeId: z.uuid(),
    platformKind: AXIS_KIND,
    scope: DATA_SCOPE,
    editable: z.boolean().meta({ description: '`scope = company`; thuộc tính chuẩn thì PUT trả 403 `platform_managed`' }),
    codes: z.array(
      z.object({ attributeCode: z.string(), attributeLabel: z.string().nullable(), priority: z.number().int().min(1) }).strict(),
    ),
    defaultCodes: z.array(z.string()).meta({ description: 'Mặc định của adapter theo `platformKind`, chỉ đọc' }),
  })
  .strict()
  .meta({ id: 'AxisMappingItem' });
export const AxisMappingList = z.object({ items: z.array(AxisMappingItemSchema) }).strict().meta({ id: 'AxisMappingList' });
// Ánh xạ thông số sang sàn (#509, Documents/21 §18.8.1).
export const SpecMappingParams = z.object({ platform: z.string().max(40), fieldId: z.uuid('Thông số không hợp lệ') });
export const SpecMappingBody = z
  .object({
    codes: z
      .array(
        z
          .object({
            attributeCode: z.string('Chọn thuộc tính của sàn').trim().min(1, 'Chọn thuộc tính của sàn').max(60),
            options: z.array(z.object({ optionId: z.uuid(), platformOptionId: z.string().max(60).nullable() }).strict()).max(500).default([]),
          })
          .strict(),
      )
      .max(20)
      .meta({ description: 'Thứ tự mảng là `priority`; `[]` là bỏ ánh xạ' }),
  })
  .strict()
  .meta({ id: 'SpecMappingInput' });
const mappingOption = z
  .object({
    optionId: z.uuid(),
    platformOptionId: z.string().nullable(),
    platformLabel: z.string().nullable(),
    scope: DATA_SCOPE,
    editable: z.boolean().meta({ description: 'Lựa chọn riêng của công ty (kể cả trên thông số chuẩn) thì sửa được' }),
  })
  .strict();
export const SpecMappingSchema = z
  .object({
    fieldId: z.uuid(),
    scope: DATA_SCOPE,
    editable: z.boolean().meta({
      description: 'Đổi được tập mã. Thông số chuẩn: PUT giữ đúng tập mã để ánh xạ lựa chọn riêng, đổi mã thì 403 `platform_managed`',
    }),
    codes: z.array(z.object({ attributeCode: z.string(), attributeLabel: z.string(), priority: z.number().int(), options: z.array(mappingOption) }).strict()),
    suggestions: z
      .array(z.object({ attributeCode: z.string(), attributeLabel: z.string(), options: z.array(mappingOption) }).strict())
      .meta({ description: 'Tính lúc đọc, không lưu: attribute property trùng tên thông số, mã chưa ánh xạ cho thông số nào' }),
  })
  .strict()
  .meta({ id: 'SpecMapping' });
export const SpecMappingList = z.object({ items: z.array(SpecMappingSchema) }).strict().meta({ id: 'SpecMappingList' });
export const AttributeCatalogQuery = z.object({
  search: z.string('Nhập ít nhất 2 ký tự').trim().min(2, 'Nhập ít nhất 2 ký tự').max(60),
  kind: z.enum(['sales', 'property']).optional(),
});
export const AttributeCatalogList = z
  .object({
    items: z.array(
      z
        .object({
          code: z.string(),
          label: z.string(),
          kind: z.enum(['sales', 'property']),
          input: z.enum(['select', 'multiselect', 'text', 'number', 'date', 'image', 'cascade']),
          options: z.array(z.object({ id: z.string(), label: z.string() }).strict()),
        })
        .strict(),
    ),
  })
  .strict()
  .meta({ id: 'AttributeCatalogList' });

/** Gom lại dữ liệu cũ (#295, 21 §18.8.4). `separateProducts`: gian hàng mà các SKU chưa gỡ của sản phẩm nằm ở hơn một sản phẩm sàn. */
export const SeparateProduct = z
  .object({
    shopId: z.uuid(),
    platform: z.string(),
    productCount: z.number().int().min(2).meta({ description: 'Số sản phẩm sàn khác nhau (`external_product_id`) của listing chưa gỡ' }),
  })
  .strict()
  .meta({ id: 'SeparateProduct' });
export const ProductListingListWithSeparate = ProductListingList.extend({ separateProducts: z.array(SeparateProduct) })
  .strict()
  .meta({ id: 'ProductListingListWithSeparate' });
export const RegroupParams = z.object({ id: z.string(), productId: z.string().max(60) });
export const RegroupQueued = z.object({ queued: z.literal(true) }).strict().meta({ id: 'RegroupQueued' });

/** Lượt đồng bộ do người bấm (Documents/21 §18 "Kết quả lượt đồng bộ"). */
export const SyncRunParams = z.object({ id: z.string(), runId: z.string() });
export const SyncRunError = z
  .object({
    listingId: z.uuid(),
    variantId: z.uuid().nullable(),
    productId: z.uuid().nullable(),
    productName: z.string().nullable(),
    attributesLabel: z.string().nullable(),
    sku: z.string().nullable().meta({ description: 'SKU người bán của listing' }),
    code: z.string(),
    message: z.string().meta({ description: 'Câu tiếng Việt cho người bán do app viết (lỗi sàn dịch bằng bảng dịch của sàn, #571)' }),
    kind: z.enum(['data', 'platform', 'connection']).nullable().meta({ description: 'Loại lỗi như `pushError.kind`; null khi lỗi do app giữ hoặc dòng ghi trước #571' }),
    target: BlockerTarget.nullable().meta({ description: 'Chỗ sửa (`BlockerTarget`); null khi không suy được' }),
    platformCode: z.string().nullable().meta({ description: 'Mã gốc của sàn; null khi lỗi do app giữ' }),
    platformMessage: z.string().nullable().meta({ description: 'Câu sàn trả, nguyên văn; null khi lỗi do app giữ' }),
    at: iso,
    fix: z
      .enum(['variant_price', 'stocktake', 'platform', 'shop_reconnect'])
      .nullable()
      .meta({ description: 'Chỗ sửa: `variant_price` mở Thông tin SKU ô Giá muốn thực nhận, `stocktake` tạo phiếu kiểm kê, `platform` sửa trên trang sàn' }),
  })
  .strict()
  .meta({ id: 'SyncRunError' });
export const SyncRun = z
  .object({
    id: z.uuid(),
    shopId: z.uuid(),
    status: z.enum(['queued', 'running', 'done', 'failed']),
    requestedAt: iso,
    startedAt: iso.nullable(),
    finishedAt: iso.nullable(),
    progress: z
      .object({
        processed: z.number().int(),
        total: z.number().int().nullable().meta({ description: 'Số listing lượt này phải đẩy; null khi đang đọc trạng thái trên sàn' }),
      })
      .strict(),
    succeeded: z.number().int(),
    failed: z.number().int(),
    errors: z.array(SyncRunError).meta({ description: 'Tối đa 200 dòng; số đủ ở `failed`' }),
    error: z
      .object({ code: z.string(), message: z.string() })
      .strict()
      .nullable()
      .meta({ description: 'Lỗi cả lượt (`status = failed`): sàn lỗi, `marketplace_unauthorized`, `shop_not_connected`, `run_stale` (quá 30 phút)' }),
  })
  .strict()
  .meta({ id: 'SyncRun' });

// Trạng thái đồng bộ category khi nối gian hàng (#569, Documents/21 §18.5).
export const CategorySyncView = z
  .object({
    tree: z
      .object({
        state: z.enum(['ready', 'queued', 'running', 'failed', 'unsupported']).meta({
          description: '`ready`: đã có cây; `unsupported`: sàn chưa đọc được category từ app; `failed` kèm `error` (nút Thử lại gọi `POST /platforms/:platform/categories/sync`)',
        }),
        syncedAt: z.string().nullable(),
        leafCount: z.number().int(),
        error: z.string().nullable(),
      })
      .strict(),
    permissions: z
      .object({
        state: z.enum(['ready', 'queued', 'running', 'failed']),
        checkedAt: z.string().nullable(),
        availableCount: z.number().int().meta({ description: 'Số category lá gian hàng được bán' }),
        error: z.string().nullable(),
      })
      .strict()
      .nullable()
      .meta({ description: '`null` khi sàn không có quyền category theo gian hàng (Lazada)' }),
  })
  .strict()
  .meta({ id: 'CategorySync' });
