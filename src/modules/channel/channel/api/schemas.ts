import { z } from 'zod';

// Sàn có adapter OAuth kiểm ở service (422 `marketplace_unsupported`), ở đây chỉ nhận đúng enum `marketplace`.
export const PlatformParams = z.object({ platform: z.enum(['lazada', 'shopee', 'tiktok', 'mock'], 'Sàn không hợp lệ') });

// `id` sai định dạng trả 404 ở service, nên ở đây chỉ là chuỗi.
export const ShopParams = z.object({ id: z.string() });

export const CallbackBody = z
  .object({
    code: z.string('Thiếu code').trim().min(1, 'Thiếu code'),
    state: z.string('Thiếu state').trim().min(1, 'Thiếu state'),
  })
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
    zeroStock: z.boolean().default(false).meta({ description: 'Đẩy tồn 0 trước khi ngắt; chưa hỗ trợ (#104), true trả 422' }),
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

export const Shop = z
  .object({
    id: z.uuid(),
    companyId: z.uuid(),
    platform: z.enum(['lazada', 'shopee', 'tiktok', 'mock']),
    externalShopId: z.string().meta({ description: 'Mã shop của sàn (Lazada: `seller_id`)' }),
    shopName: z.string(),
    region: z.string().nullable(),
    status: z.enum(['connecting', 'active', 'needs_reauth', 'disconnected']),
    accessExpiresAt: iso.nullable(),
    refreshExpiresAt: iso.nullable(),
    tokenExpiringSoon: z.boolean().meta({ description: 'Đang active và refresh token còn dưới 3 ngày' }),
    lastOrderSyncAt: iso.nullable(),
    orderCutoffAt: iso.nullable().meta({ description: 'Mốc kéo đơn, null khi chưa thiết lập' }),
    pendingJobs: z.number().int(),
    listingCount: z.number().int().meta({ description: 'Số listing còn trên sàn' }),
    version: z.number().int(),
    createdAt: iso,
    updatedAt: iso,
  })
  .strict()
  .meta({ id: 'Shop' });

export const ShopDetail = Shop.extend({ statusHistory: z.array(StatusChange) }).meta({ id: 'ShopDetail' });

export const ShopList = z.object({ items: z.array(Shop) }).strict().meta({ id: 'ShopList' });

export const ShopCallbackResult = z
  .object({
    shop: Shop,
    created: z.boolean(),
    reconnect: z
      .object({ pulledFrom: iso.nullable(), relisted: z.number().int(), jobsRun: z.number().int() })
      .strict()
      .nullable(),
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
    platform: z.enum(['lazada', 'shopee', 'tiktok', 'mock']),
    externalCategoryId: z.string(),
    attributes: z.record(z.string(), z.string()),
    version: z.number().int(),
    updatedAt: iso,
  })
  .strict()
  .meta({ id: 'CategoryMap' });

export const CategoryMapList = z.object({ items: z.array(CategoryMap) }).strict().meta({ id: 'CategoryMapList' });
