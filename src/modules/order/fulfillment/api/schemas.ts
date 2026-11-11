// Schema Zod của kiện (Documents/21 §19.2). Một nơi dựng `PackageSummary` cho cả route kiện và chi tiết đơn của sales
// (spec 199a D8). Tên `.meta({ id })` trùng kiểu ở FE.
import { z } from 'zod';
import { StatusChangeSchema } from '../../../../shared/http/status-change.ts';
import { PACKAGE_TABS } from '../domain/package.ts';

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

/** `StatusChange` của Documents/21 §14.1: schema dùng chung ở `shared/http/status-change.ts` (#246). */
export const StatusChange = StatusChangeSchema;

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

export const PackageListQuery = z.object({
  tab: z.enum(PACKAGE_TABS).default('reserved').meta({
    description: '`reserved` chỉ kiện của đơn đang xử lý; `shipping` gồm `in_transit`, `self_delivering`; `needs_open` theo cờ',
  }),
  search: z.string().trim().max(100).optional().meta({ description: 'Mã kiện, mã đơn hoặc mã vận đơn, không phân biệt hoa thường' }),
  source: z.enum(['marketplace', 'inbox', 'manual']).optional(),
  shopId: z.uuid('Gian hàng không hợp lệ').optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const PackageParams = z.object({ id: z.string() });

export const PackagePage = z
  .object({
    items: z.array(PackageSummary),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
    counts: z
      .object(Object.fromEntries(PACKAGE_TABS.map((t) => [t, z.number().int()])) as Record<(typeof PACKAGE_TABS)[number], z.ZodNumber>)
      .strict()
      .meta({ description: 'Số kiện mỗi tab theo `search`, `source`, `shopId`, không theo `tab`' }),
  })
  .strict()
  .meta({ id: 'PackagePage' });

export const Package = PackageSummary.extend({ statusHistory: z.array(StatusChange) })
  .strict()
  .meta({ id: 'Package' });

export const HandOverBody = z.object({
  packages: z
    .array(z.object({ id: z.uuid('Mã kiện không hợp lệ'), version: z.number().int().min(0) }))
    .min(1, 'Quét ít nhất một kiện')
    .max(50, 'Mỗi lần bàn giao tối đa 50 kiện')
    // Zod 4: `.refine` trên mảng, lỗi nằm ở `errors.packages`.
    .refine((items) => new Set(items.map((i) => i.id)).size === items.length, 'Mỗi kiện chỉ quét một lần'),
});

export const HandOverResult = z
  .object({
    handedOver: z.array(
      z
        .object({
          id: z.uuid(),
          code: z.string(),
          issue: z
            .object({ id: z.uuid(), number: z.string() })
            .nullable()
            .meta({ description: 'Phiếu xuất `XK`; null khi kiện chưa có dòng nào ghép SKU (trừ khi ghép muộn)' }),
        })
        .strict(),
    ),
    failed: z.array(
      z
        .object({
          packageId: z.string(),
          code: z.enum(['not_found', 'version_conflict', 'already_handed_over', 'invalid_transition', 'internal_error']),
          detail: z.string(),
        })
        .strict(),
    ),
  })
  .strict()
  .meta({ id: 'HandOverResult' });

export const UndoHandoverBody = z.object({
  version: z.number().int().min(0),
  // Bắt buộc lý do do máy trạng thái kiểm (422 `reason_required`), nên ở đây cho phép rỗng.
  reason: z.string().trim().max(500, 'Lý do tối đa 500 ký tự').default(''),
});
