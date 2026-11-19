// Schema Zod của kiện (Documents/21 §19.2). Một nơi dựng `PackageSummary` cho cả route kiện và chi tiết đơn của sales
// (spec 199a D8). Tên `.meta({ id })` trùng kiểu ở FE.
import { z } from 'zod';
import { StatusChangeSchema } from '../../../../shared/http/status-change.ts';
import { HANDOVER_SOURCES } from '../domain/handover.ts';
import { OPEN_PURPOSES } from '../domain/open-purpose.ts';
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
export const PACKAGE_FLAGS = ['needs_open', 'needs_attention', 'cancel_requested', 'lost_reported', 'pickup_unconfirmed', 'label_error'] as const;

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
      description: '`cancel_requested`: khách đang xin huỷ đơn, chờ Sale trả lời; kiện chưa báo sàn sẵn sàng giao được. `pickup_unconfirmed`: kho quét bàn giao quá 24 giờ mà sàn chưa xác nhận lấy. `label_error`: lần báo sẵn sàng giao gần nhất gặp lỗi từ sàn',
    }),
    flagNote: z.string().nullable(),
    notices: z
      .array(z.object({ code: z.literal('not_implemented'), issue: z.string(), owner: z.string(), message: z.string() }).strict())
      .meta({ description: 'Việc chạy ngầm chưa làm được vì chờ issue khác, vd giữ hàng khi `reserve` chờ commerio-backend#206 (21 §18.7.9). Rỗng khi không có' }),
    openPurpose: z.enum(OPEN_PURPOSES).nullable().meta({
      description:
        'Vì sao kiện chờ mở; `stocktake`: phiếu kiểm kê đếm thấp hơn hàng trong kiện (#238); `remap`: đổi ghép SKU: dỡ kiện, mở ra là áp ghép mới (#237)',
    }),
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
      z.object({
        id: z.uuid().meta({ description: 'Id dòng kiện; `pack.untrackedLines[].lineId` trỏ tới đây' }),
        variantId: z.uuid().nullable(),
        untracked: z.boolean().meta({ description: 'Dòng "không quản tồn": không biến thể, không giữ, không trừ tồn (như dòng đơn §19.1)' }),
        sku: z.string().meta({ description: 'Dòng đã ghép: SKU biến thể app mà dòng kiện giữ. Chưa ghép hay "không quản tồn": SKU sàn' }),
        productName: z.string().meta({ description: 'Dòng đã ghép: tên sản phẩm app. Chưa ghép hay "không quản tồn": tên trên sàn' }),
        attributesLabel: z.string().meta({ description: 'Dòng đã ghép: nhãn thuộc tính biến thể app. Chưa ghép hay "không quản tồn": của sàn' }),
        externalSku: z.string().nullable().meta({ description: 'SKU người bán trên sàn; null với đơn tay' }),
        quantity: z.number().int().meta({ description: 'Số đang nằm trong kiện, gồm cả phần chờ bỏ' }),
        pendingDropQty: z.number().int().min(0).meta({
          description: 'Phần chờ bỏ (0..`quantity`): sàn đã huỷ món của kiện đã đóng gói, kho bỏ ra khi mở kiện (#205). 0 khi không chờ bỏ',
        }),
        remapPending: z.boolean().meta({
          description: 'Món trong hộp theo ghép cũ, kho mở kiện để áp ghép mới (#237); chỉ true khi kiện còn đóng',
        }),
      }),
    ),
    totalQty: z.number().int().meta({ description: 'Tổng `quantity` của các dòng, gồm cả phần chờ bỏ' }),
    handedOverAt: iso.nullable(),
    handoverSource: z.enum(HANDOVER_SOURCES).nullable().meta({
      description:
        'Ai đưa kiện ra khỏi kho: `scan` kho quét, `marketplace` sàn báo, `forced` bàn giao bắt buộc khi thiếu hàng, `before_cutoff` kiện rời kho trước mốc kéo đơn (chỉ lưu). Null khi kiện chưa rời kho. Chỉ kiện `scan` chưa có `pickupConfirmedAt` mới đảo bàn giao được (21 §19.2)',
    }),
    pickupConfirmedAt: iso.nullable().meta({
      description: 'Lúc sàn xác nhận đơn vị vận chuyển đã lấy kiện (kiện sàn báo rời kho: bằng `handedOverAt`). Null khi chưa xác nhận hoặc kiện chưa rời kho',
    }),
    deliveredAt: iso.nullable(),
    deliveredBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    lostReport: z.object({ by: z.object({ id: z.uuid(), name: z.string() }), at: iso, claimCode: z.string() }).nullable(),
    replaces: z.object({ id: z.uuid(), code: z.string(), status: z.enum(PACKAGE_STATUS) }).nullable().meta({
      description: 'Kiện cũ mà kiện này thay khi sàn chia lại kiện (#238); kiện cũ còn `packed`/`awaiting_pickup` thì kiện này chờ kho mở kiện cũ',
    }),
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
          code: z.enum(['not_found', 'version_conflict', 'already_handed_over', 'invalid_transition', 'awaiting_open', 'internal_error']),
          detail: z.string(),
        })
        .strict(),
    ),
  })
  .strict()
  .meta({ id: 'HandOverResult' });

/** Số kho quét từng món lúc nhận hàng về (Documents/21 §15.3; dùng chung với `/returns/receive` của sales): số nguyên ≥ 0, `variantId` không lặp. */
export const ScanLines = z.array(z.object({ variantId: z.string().min(1), quantity: z.number().int('Số lượng phải là số nguyên').min(0, 'Số lượng không âm') })).superRefine((lines, ctx) => {
  const seen = new Set<string>();
  lines.forEach((l, i) => {
    if (seen.has(l.variantId)) ctx.addIssue({ code: 'custom', path: [i, 'variantId'], message: 'Biến thể bị lặp' });
    seen.add(l.variantId);
  });
});

const scanLines = ScanLines.optional().meta({
  description: 'Số kho quét từng món; tuỳ chọn trong giai đoạn chuyển tiếp (21 §15.3), không gửi thì coi như quét đủ. Mảng rỗng: không quét được món nào',
});

/** Quét nhận hàng hoàn (spec 199c §5.5): `code` là mã kiện hoặc mã vận đơn, không phân biệt hoa thường. */
export const ReceiveReturnBody = z.object({
  version: z.int().min(0),
  code: z.string().trim().min(1, 'Nhập hoặc quét mã kiện').max(100, 'Mã tối đa 100 ký tự'),
  lines: scanLines,
});

/** Kho nhận kiện thất lạc tìm thấy (Documents/21 §19.2): `lines` như `receive-return`. */
export const FoundBody = z.object({ version: z.int().min(0), lines: scanLines });

/** Kho báo kiện thất lạc (Documents/21 §19.2, spec #238 §5.3): mã khiếu nại 1–100 ký tự sau khi cắt khoảng trắng. */
export const ReportLostBody = z
  .object({ version: z.int().min(0), claimCode: z.string().trim().min(1, 'Nhập mã khiếu nại').max(100, 'Mã khiếu nại tối đa 100 ký tự') })
  .meta({ id: 'ReportLostBody' });

/** Người khác người báo xác nhận kiện thất lạc (spec #238 §5.3). */
export const ConfirmLostBody = z.object({ version: z.int().min(0) }).meta({ id: 'ConfirmLostBody' });

export const UndoHandoverBody = z.object({
  version: z.number().int().min(0),
  // Bắt buộc lý do do máy trạng thái kiểm (422 `reason_required`), nên ở đây cho phép rỗng.
  reason: z.string().trim().max(500, 'Lý do tối đa 500 ký tự').default(''),
});

const uuid = z.uuid();
export function idsCsv(max: number) {
  const split = (value: string) => value.split(',').map((id) => id.trim().toLowerCase());
  return z.string().refine((value) => {
    const ids = split(value);
    return ids.length <= max && new Set(ids).size === ids.length && ids.every((id) => uuid.safeParse(id).success);
  }, `Chọn từ 1 đến ${max} kiện, mã kiện hợp lệ và không trùng`).transform(split)
    .meta({ description: `1–${max} UUID phân cách bằng dấu phẩy, không trùng` });
}

export const PickListQuery = z.object({ ids: idsCsv(200).optional() }).meta({ id: 'PickListQuery' });

export const PickList = z.object({
  items: z.array(z.object({
    variantId: z.uuid().nullable(),
    untracked: z.boolean().meta({ description: 'Dòng "không quản tồn" (gộp theo SKU sàn, tách khỏi dòng chưa ghép cùng SKU)' }),
    sku: z.string().meta({ description: 'Đã ghép: SKU biến thể app (gộp theo biến thể). Chưa ghép hay "không quản tồn": SKU sàn (gộp theo SKU sàn)' }),
    productName: z.string(), attributesLabel: z.string(),
    quantity: z.number().int().positive(), packageCount: z.number().int().positive(),
  }).strict()),
  packageCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
}).strict().meta({ id: 'PickList' });

export const CarrierList = z.object({
  items: z.array(z.object({ code: z.string(), name: z.string(), isDefault: z.boolean() }).strict()),
}).strict().meta({ id: 'CarrierList' });

const version = z.number().int().min(0);
export const PackBody = z.object({
  version,
  lines: z.array(z.object({
    variantId: z.uuid().transform((id) => id.toLowerCase()),
    quantity: z.number().int().min(1).max(10_000),
  })).max(200).refine((lines) => new Set(lines.map((line) => line.variantId)).size === lines.length, 'Mỗi biến thể chỉ quét một lần'),
  untrackedLines: z.array(z.object({
    lineId: z.uuid().transform((id) => id.toLowerCase()),
    quantity: z.number().int().min(1).max(10_000),
  })).max(200).refine((lines) => new Set(lines.map((line) => line.lineId)).size === lines.length, 'Mỗi dòng chỉ ghi một lần')
    .optional().meta({ description: 'Số đã cho vào hộp của từng dòng "không quản tồn" (`Package.lines[].id`), phải đủ như dòng đã ghép' }),
  carrierCode: z.string().trim().min(1).max(100).optional(),
}).meta({ id: 'PackBody' });

/** Tách kiện (Documents/21 §19.2, spec 205 §5.2): mỗi phần thành một kiện mới, kiện cũ giữ phần còn lại. */
export const SplitBody = z.object({
  version,
  parts: z.array(
    z.array(z.object({
      variantId: z.uuid('Biến thể không hợp lệ').transform((id) => id.toLowerCase()),
      quantity: z.number().int('Số lượng phải là số nguyên').min(1, 'Số lượng phải lớn hơn 0'),
    })).min(1, 'Mỗi kiện mới cần ít nhất một món').max(200, 'Mỗi kiện mới tối đa 200 dòng').superRefine((items, ctx) => {
      const seen = new Set<string>();
      items.forEach((item, i) => {
        if (seen.has(item.variantId)) ctx.addIssue({ code: 'custom', path: [i, 'variantId'], message: 'Biến thể bị lặp trong cùng một kiện mới' });
        seen.add(item.variantId);
      });
    }),
  ).min(1, 'Chọn ít nhất một kiện mới').max(20, 'Tách tối đa 20 kiện mới một lần'),
}).meta({ id: 'SplitPackageBody' });

export const ReadyBody = z.object({ version }).meta({ id: 'ReadyBody' });
export const OpenBody = z.object({ version }).meta({ id: 'OpenBody' });

export const PackageDocumentsQuery = z.object({
  ids: idsCsv(50),
  kind: z.enum(['awb']).default('awb'),
}).meta({ id: 'PackageDocumentsQuery' });
