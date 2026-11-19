// Ai nhận thông báo nào và thông báo mang trường gì (Documents/21 D11, §13; UC-NO-01). Luật thuần, không I/O.
import { Decimal } from 'decimal.js';
import { type CompanyAccess, moduleOfPermission } from '../../../../shared/auth/company-access.ts';
import type { EventEnvelope, EventPayload, EventType } from '../../platform/index.ts';

/** Tiền trong sự kiện là chuỗi thập phân; ra FE là số nguyên đồng, làm tròn nửa lên như REST (V29). */
const dong = (amount: string) => new Decimal(amount).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();

interface Rule<T extends EventType> {
  /** Có một trong các quyền này thì nhận. */
  readonly permissions: readonly string[];
  /** Chỉ các trường này đi xuống trình duyệt; trường khác của sự kiện không lộ ra. */
  readonly fields: (payload: EventPayload<T>) => Record<string, unknown>;
}

/**
 * Loại không có ở đây thì không gửi ai (consumer `notification-sse` cũng không nghe). Thêm loại: chọn quyền và trường,
 * rồi thêm dòng vào test và §13. `fulfillment.order_status_changed`, `payment.succeeded` đã bỏ ở #216.
 */
const RULES: { readonly [T in EventType]?: Rule<T> } = {
  'sales.order_created': {
    permissions: ['sales.order.view'],
    fields: ({ orderId, code, source, total }) => ({ orderId, code, source, total: dong(total) }),
  },
  // Mô hình đơn, kiện, trả, gian hàng (Documents/21 §13.2 "Sự kiện của mô hình mới", #216). FE gọi lại GET, payload
  // chỉ mang id, from/to, cờ; riêng kiện giao không thành công, thất lạc mang `reason`/`claimCode` để dựng toast.
  'sales.order_status_changed': {
    permissions: ['sales.order.view'],
    fields: ({ orderId, code, from, to, flags }) => ({ orderId, code, from, to, flags }),
  },
  'fulfillment.package_status_changed': {
    permissions: ['sales.order.view', 'fulfillment.order.process'],
    fields: ({ packageId, orderId, from, to }) => ({ packageId, orderId, from, to }),
  },
  'fulfillment.package_delivery_failed': {
    permissions: ['sales.order.view', 'fulfillment.order.process'],
    fields: ({ packageId, orderId, reason }) => ({ packageId, orderId, reason }),
  },
  'fulfillment.package_lost': {
    permissions: ['sales.order.view', 'fulfillment.order.process'],
    fields: ({ packageId, orderId, claimCode }) => ({ packageId, orderId, claimCode }),
  },
  'sales.return_status_changed': {
    permissions: ['sales.return.view'],
    fields: ({ returnId, orderId, from, to }) => ({ returnId, orderId, from, to }),
  },
  'channel.shop_status_changed': {
    permissions: ['channel.shop.view'],
    fields: ({ shopId, from, to }) => ({ shopId, from, to }),
  },
  'channel.listing_sync_changed': {
    permissions: ['channel.shop.view'],
    fields: ({ shopId, listingId, stockSync, priceSync, status }) => ({ shopId, listingId, stockSync, priceSync, status }),
  },
  'inventory.below_threshold': {
    permissions: ['inventory.stock.view'],
    fields: ({ variantId, available, minQty }) => ({ variantId, available, minQty }),
  },
  'inventory.receipt_posted': {
    permissions: ['inventory.stock.view'],
    fields: ({ receiptId, number, kind }) => ({ receiptId, number, kind }),
  },
  'purchasing.request_submitted': {
    permissions: ['purchasing.request.approve'],
    fields: ({ requestId, number }) => ({ requestId, number }),
  },
};

/** Các loại sự kiện realtime nghe. */
export const NOTIFIED_TYPES = Object.keys(RULES) as EventType[];

/** Quyền có hiệu lực: bỏ quyền của phân hệ đang tắt (Documents/21 mục 8). */
export function effectivePermissions(access: CompanyAccess): ReadonlySet<string> {
  const enabled = new Set(access.enabledModules);
  return new Set(access.permissions.filter((p) => enabled.has(moduleOfPermission(p))));
}

export function canReceive(permissions: ReadonlySet<string>, type: EventType): boolean {
  return RULES[type]?.permissions.some((p) => permissions.has(p)) ?? false;
}

/** Thân `data` của một message SSE. Không có `companyId`, `aggregateId` (bên phát có thể đặt là mã giao dịch). */
export interface NotificationMessage {
  readonly eventId: string;
  readonly type: EventType;
  readonly occurredAt: string;
  readonly payload: Record<string, unknown>;
}

export function toMessage(event: EventEnvelope<EventType>): NotificationMessage | null {
  const rule = RULES[event.type] as Rule<EventType> | undefined;
  if (!rule) return null;
  return { eventId: event.eventId, type: event.type, occurredAt: event.occurredAt, payload: rule.fields(event.payload as never) };
}
