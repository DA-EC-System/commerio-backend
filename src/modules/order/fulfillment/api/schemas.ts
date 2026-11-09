// Schema Zod của kiện (Documents/21 §19.2). Một nơi dựng `PackageSummary` cho cả route kiện và chi tiết đơn của sales
// (spec 199a D8). Tên `.meta({ id })` trùng kiểu ở FE.
import { z } from 'zod';

const iso = z.iso.datetime();

export const ORDER_STATUS = ['unpaid', 'processing', 'completed', 'cancelled'] as const;
export const PACKAGE_STATUS = [
  'backordered',
  'reserved',
  'packed',
  'awaiting_pickup',
  'self_delivering',
  'in_transit',
  'delivered',
  'delivery_failed',
  'returning',
  'returned',
  'lost',
  'cancelled',
] as const;
export const PACKAGE_FLAGS = ['needs_open', 'needs_attention', 'lost_reported', 'pickup_unconfirmed'] as const;

export const ShopRef = z.object({ id: z.uuid(), shopName: z.string(), platform: z.string() }).meta({ id: 'OrderShopRef' });

/** `StatusChange` của Documents/21 §14.1; không đặt `id` vì channel đã đăng ký tên này. */
export const StatusChange = z
  .object({
    at: iso,
    from: z.string().nullable(),
    to: z.string(),
    by: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    source: z.enum(['user', 'marketplace', 'system']),
    reason: z.string().nullable(),
  })
  .strict();

export const PackageSummary = z
  .object({
    id: z.uuid(),
    code: z.string(),
    order: z.object({ id: z.uuid(), code: z.string(), status: z.enum(ORDER_STATUS) }),
    source: z.enum(['marketplace', 'inbox', 'manual']),
    shop: ShopRef.nullable(),
    customerName: z.string().nullable(),
    status: z.enum(PACKAGE_STATUS),
    flags: z.array(z.enum(PACKAGE_FLAGS)).meta({
      description: '`pickup_unconfirmed`: kho quét bàn giao quá 24 giờ mà sàn chưa xác nhận lấy (suy từ `pickup_confirmed_at`, không lưu)',
    }),
    flagNote: z.string().nullable(),
    notices: z
      .array(z.object({ code: z.literal('not_implemented'), issue: z.string(), owner: z.string(), message: z.string() }).strict())
      .meta({ description: 'Việc chạy ngầm chưa làm được vì chờ issue khác, vd giữ hàng khi `reserve` chờ commerio-backend#206 (21 §18.7.9). Rỗng khi không có' }),
    openPurpose: z.enum(['cancel', 'edit', 'resplit']).nullable(),
    selfDelivery: z.boolean(),
    paymentMethod: z.enum(['prepaid', 'cod']).nullable(),
    paymentStatus: z.string().nullable().meta({ description: 'Chưa có: luôn null tới khi có trạng thái tiền theo đơn tay' }),
    trackingCode: z.string().nullable(),
    platformPackageCode: z.string().nullable(),
    carrier: z.object({ code: z.string(), name: z.string() }).nullable().meta({ description: 'Chọn lúc đóng gói (#239)' }),
    shipmentProvider: z.string().nullable().meta({ description: 'Đơn vị vận chuyển sàn trả' }),
    shippingProviderType: z.string().nullable().meta({ description: 'Gói giao của sàn (`standard`, `seller_own_fleet`…)' }),
    promisedShippingAt: iso.nullable().meta({ description: 'Hạn sàn hứa gửi; null khi sàn không trả' }),
    shipBy: iso.nullable(),
    lines: z.array(
      z.object({ variantId: z.uuid().nullable(), sku: z.string(), productName: z.string(), attributesLabel: z.string(), quantity: z.number().int() }),
    ),
    totalQty: z.number().int(),
    handedOverAt: iso.nullable(),
    deliveredAt: iso.nullable(),
    deliveredBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    lostReport: z.object({ by: z.object({ id: z.uuid(), name: z.string() }), at: iso, claimCode: z.string() }).nullable(),
    createdAt: iso,
    version: z.number().int(),
  })
  .strict()
  .meta({ id: 'PackageSummary' });
