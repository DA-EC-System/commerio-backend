import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EVENT_SCHEMAS, EVENT_TYPES, type EventPayload, type EventType } from '#src/modules/platform/domain/events.ts';
import { modules } from '#src/modules/registry.ts';
import { topicOf } from '#src/shared/events/envelope.ts';

const id = () => randomUUID();
const at = '2026-10-18T09:00:00.000+07:00';

/** Một payload mẫu hợp lệ cho mỗi loại sự kiện. Thêm loại mới mà không thêm mẫu thì test đỏ. */
const SAMPLES: { [T in EventType]: EventPayload<T> } = {
  'inventory.stock_changed': { variantId: id(), onHand: 10, reserved: 2, available: 8 },
  'inventory.below_threshold': { variantId: id(), available: 1, minQty: 5 },
  'inventory.receipt_posted': { receiptId: id(), number: 'PN-0001', kind: 'purchase', lines: [{ variantId: id(), quantity: 3 }] },
  'inventory.issue_posted': { issueId: id(), number: 'PX-0001', kind: 'order', orderId: id(), postedAt: at },
  'sales.order_created': { orderId: id(), code: 'DH-0001', source: 'manual', total: '150000.00' },
  'fulfillment.order_status_changed': { orderId: id(), from: 'confirmed', to: 'picking', isShortStock: false },
  'payment.succeeded': { orderId: id(), paymentTransactionId: id(), gateway: 'vnpay', amount: '150000.00' },
  'finance.invoice_posted': { invoiceId: id(), orderId: id(), total: '150000.00', issuedAt: at, reversalOf: null },
  'finance.receipt_posted': { receiptId: id(), orderId: null, amount: '-50000.00', source: 'gateway', postedAt: at, reversalOf: id() },
  'finance.voucher_posted': { voucherId: id(), purpose: 'customer_refund', orderId: id(), amount: '50000.00', paidOn: '2026-10-18', reversalOf: null },
  'purchasing.order_submitted': { purchaseOrderId: id(), code: 'PO-0001' },
};

describe('danh mục sự kiện (AC-11)', () => {
  it('mỗi loại có mẫu, mẫu parse được bằng schema của loại đó', () => {
    expect([...EVENT_TYPES].sort()).toEqual(Object.keys(SAMPLES).sort());
    for (const type of EVENT_TYPES) expect(EVENT_SCHEMAS[type].safeParse(SAMPLES[type]).success, type).toBe(true);
  });

  it('tiền tố của type là một module có thật, topic mặc định là commerio.<module>', () => {
    const names = modules.map((m) => m.name);
    for (const type of EVENT_TYPES) {
      const module = type.split('.')[0]!;
      expect(names).toContain(module);
      expect(topicOf(type, 'commerio')).toBe(`commerio.${module}`);
    }
  });

  it('payload sai bị từ chối: thiếu trường, tiền là number, trạng thái lạ', () => {
    const missing: Record<string, unknown> = { ...SAMPLES['inventory.stock_changed'] };
    delete missing.variantId;
    expect(EVENT_SCHEMAS['inventory.stock_changed'].safeParse(missing).success).toBe(false);
    expect(EVENT_SCHEMAS['sales.order_created'].safeParse({ ...SAMPLES['sales.order_created'], total: 150000 }).success).toBe(false);
    expect(
      EVENT_SCHEMAS['fulfillment.order_status_changed'].safeParse({ ...SAMPLES['fulfillment.order_status_changed'], to: 'shipped' }).success,
    ).toBe(false);
  });
});
