// Ai nhận thông báo nào và thông báo mang trường gì (Documents/21 D11, §13; UC-NO-01). Luật thuần, không I/O.
import { Decimal } from 'decimal.js';
import { type CompanyAccess, moduleOfPermission } from '../../../shared/auth/company-access.ts';
import type { EventEnvelope, EventPayload, EventType } from '../../platform/index.ts';

/** Tiền trong sự kiện là chuỗi thập phân; ra FE là số nguyên đồng, làm tròn nửa lên như REST (V29). */
const dong = (amount: string) => new Decimal(amount).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();

interface Rule<T extends EventType> {
  /** Có một trong các quyền này thì nhận. */
  readonly permissions: readonly string[];
  /** Chỉ các trường này đi xuống trình duyệt; trường khác của sự kiện không lộ ra. */
  readonly fields: (payload: EventPayload<T>) => Record<string, unknown>;
}

/** Loại không có ở đây thì không gửi ai. Thêm loại: chọn quyền và trường, rồi thêm dòng vào test và §13. */
const RULES: { readonly [T in EventType]?: Rule<T> } = {
  'sales.order_created': {
    permissions: ['sales.order.view'],
    fields: ({ orderId, code, source, total }) => ({ orderId, code, source, total: dong(total) }),
  },
  // Gồm "đơn thiếu hàng" (isShortStock).
  'fulfillment.order_status_changed': {
    permissions: ['sales.order.view'],
    fields: ({ orderId, from, to, isShortStock }) => ({ orderId, from, to, isShortStock }),
  },
  // A1: Sale hoặc người có quyền tài chính. Không gửi mã giao dịch và cổng (cần payment.transaction.view, T13).
  'payment.succeeded': {
    permissions: ['sales.order.view', 'finance.invoice.view'],
    fields: ({ orderId, amount }) => ({ orderId, amount: dong(amount) }),
  },
  'inventory.below_threshold': {
    permissions: ['inventory.stock.view'],
    fields: ({ variantId, available, minQty }) => ({ variantId, available, minQty }),
  },
  'inventory.receipt_posted': {
    permissions: ['inventory.stock.view'],
    fields: ({ receiptId, number, kind }) => ({ receiptId, number, kind }),
  },
  'purchasing.order_submitted': {
    permissions: ['purchasing.order.approve'],
    fields: ({ purchaseOrderId, code }) => ({ purchaseOrderId, code }),
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
