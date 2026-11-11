import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EVENT_SCHEMAS, EVENT_TYPES, type EventPayload, type EventType } from '#src/modules/core/platform/domain/events.ts';
import { modules } from '#src/modules/registry.ts';
import { topicOf } from '#src/shared/events/envelope.ts';

const id = () => randomUUID();
const at = '2026-10-18T09:00:00.000+07:00';

/** Một payload mẫu hợp lệ cho mỗi loại sự kiện. Thêm loại mới mà không thêm mẫu thì test đỏ. */
const SAMPLES: { [T in EventType]: EventPayload<T> } = {
  'inventory.stock_changed': { variantId: id(), onHand: 10, reserved: 2, available: 8 },
  'inventory.below_threshold': { variantId: id(), available: 1, minQty: 5 },
  'inventory.receipt_posted': { receiptId: id(), number: 'PN-0001', kind: 'purchase', lines: [{ variantId: id(), quantity: 3 }] },
  'inventory.stocktake_posted': {
    documentId: id(),
    number: 'KK-000001',
    source: { type: 'shop_setup', shopId: id() },
    postedAt: at,
    countedAt: at,
    lines: [{ variantId: id(), countedQty: 4, delta: -1 }],
  },
  'inventory.issue_posted': { issueId: id(), number: 'PX-0001', kind: 'order', orderId: id(), postedAt: at },
  'sales.order_created': { orderId: id(), code: 'DH-0001', source: 'manual', total: '150000.00' },
  'sales.order_status_changed': { orderId: id(), code: 'DH-000001', from: null, to: 'processing', flags: ['unmapped_sku'] },
  'sales.order_cancelled': { orderId: id(), code: 'DH-000001', source: 'marketplace', by: 'platform' },
  'sales.return_refunded': { returnRequestId: id(), orderId: id(), shopId: id(), refundAmount: '32000.00', refundedAt: at },
  'inventory.return_inspected': {
    inspectionId: id(),
    orderId: id(),
    shopId: null,
    inspectedAt: at,
    lines: [{ variantId: id(), resellable: 1, unitCost: '15000.00' }],
  },
  'fulfillment.package_status_changed': { packageId: id(), orderId: id(), from: 'reserved', to: 'packed' },
  'fulfillment.package_shipped': { packageId: id(), orderId: id(), lines: [{ variantId: id(), quantity: 2, unitCost: '100000.00' }] },
  'fulfillment.allocation_done': { variantIds: [id(), id()] },
  'fulfillment.package_delivered': {
    packageId: id(),
    orderId: id(),
    shopId: id(),
    deliveredAt: at,
    lines: [
      { variantId: id(), quantity: 2, unitPrice: '150000.00', unitCost: '100000.00' },
      { variantId: id(), quantity: 1, unitPrice: '90000.00', unitCost: null },
    ],
    platformSubsidy: '10000.00',
    shippingIncome: '30000.00',
    shippingCost: '25000.00',
  },
  'fulfillment.package_delivery_failed': { packageId: id(), orderId: id(), reason: 'Khách không nghe máy' },
  'fulfillment.package_returned': { packageId: id(), orderId: id(), shopId: id(), returnedAt: at },
  'fulfillment.package_lost': { packageId: id(), orderId: id(), claimCode: null },
  'fulfillment.order_status_changed': { orderId: id(), from: 'confirmed', to: 'picking', isShortStock: false },
  'payment.succeeded': { orderId: id(), paymentTransactionId: id(), gateway: 'vnpay', amount: '150000.00' },
  'finance.invoice_posted': { invoiceId: id(), orderId: id(), total: '150000.00', issuedAt: at, reversalOf: null },
  'finance.receipt_posted': { receiptId: id(), orderId: null, amount: '-50000.00', source: 'gateway', postedAt: at, reversalOf: id() },
  'finance.voucher_posted': { voucherId: id(), purpose: 'customer_refund', orderId: id(), amount: '50000.00', paidOn: '2026-10-18', reversalOf: null },
  'finance.fee_config_activated': { configVersionId: id(), kind: 'fee', shopId: id(), effectiveFrom: '2026-11-01', supersededId: null },
  'purchasing.request_submitted': { requestId: id(), number: 'DN-000001' },
  'purchasing.goods_receipt_posted': { receiptId: id(), requestId: id(), lines: [{ variantId: id(), accepted: 5, defective: 1 }] },
  'staff.invitation_otp_requested': { invitationId: id(), requestedAt: '2026-10-21T00:00:00.000Z' },
};

describe('danh mục sự kiện (AC-11)', () => {
  it('inventory.stocktake_posted thiếu countedAt thì bị từ chối, không lấy postedAt thay (#198, Documents/21 §11.2)', () => {
    const noCountedAt: Record<string, unknown> = { ...SAMPLES['inventory.stocktake_posted'] };
    delete noCountedAt.countedAt;
    expect(EVENT_SCHEMAS['inventory.stocktake_posted'].safeParse(noCountedAt).success).toBe(false);
  });

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

  it('xin mã OTP lời mời: thiếu requestedAt, hay requestedAt không phải thời điểm, bị từ chối (#7 [C])', () => {
    const schema = EVENT_SCHEMAS['staff.invitation_otp_requested'];
    expect(schema.safeParse({ invitationId: id() }).success).toBe(false);
    expect(schema.safeParse({ invitationId: id(), requestedAt: 'hom qua' }).success).toBe(false);
  });

  describe('fulfillment.package_shipped (21 §11.2)', () => {
    const schema = EVENT_SCHEMAS['fulfillment.package_shipped'];
    const shipped = SAMPLES['fulfillment.package_shipped'];
    const withLine = (patch: Record<string, unknown>) => ({ ...shipped, lines: [{ ...shipped.lines[0]!, ...patch }] });

    it('từ chối unitCost là number', () => {
      expect(schema.safeParse(withLine({ unitCost: 100000 })).success).toBe(false);
    });

    it('từ chối unitCost null', () => {
      expect(schema.safeParse(withLine({ unitCost: null })).success).toBe(false);
    });

    it('từ chối quantity bằng 0', () => {
      expect(schema.safeParse(withLine({ quantity: 0 })).success).toBe(false);
    });
  });

  describe('fulfillment.package_delivered (21 §11.2, #199c)', () => {
    const schema = EVENT_SCHEMAS['fulfillment.package_delivered'];
    const sample = SAMPLES['fulfillment.package_delivered'];

    it('chấp nhận dòng kiện chưa ghép SKU (variantId null)', () => {
      const lines = [
        { variantId: null, quantity: 1, unitPrice: '150000.00', unitCost: null },
        { variantId: id(), quantity: 2, unitPrice: '90000.00', unitCost: '50000.00' },
      ];
      expect(schema.safeParse({ ...sample, lines }).success).toBe(true);
    });

    it('vẫn từ chối variantId không phải uuid', () => {
      const lines = [{ variantId: 'abc', quantity: 1, unitPrice: '90000.00', unitCost: null }];
      expect(schema.safeParse({ ...sample, lines }).success).toBe(false);
    });
  });

  describe('fulfillment.allocation_done (21 §11.2, Documents#95)', () => {
    const schema = EVENT_SCHEMAS['fulfillment.allocation_done'];
    const documentId = id();

    it('nhận lượt phân hàng thường, không có cause', () => {
      const parsed = schema.safeParse({ variantIds: [id()] });
      expect(parsed.success).toBe(true);
      expect(parsed.data).not.toHaveProperty('cause');
    });

    it('nhận lượt do phiếu kiểm kê đầu kỳ, có cause, kể cả variantIds rỗng', () => {
      const payload = { variantIds: [], cause: { type: 'stocktake', documentId } };
      expect(schema.safeParse(payload).data).toEqual(payload);
    });

    it('từ chối cause có type khác stocktake', () => {
      expect(schema.safeParse({ variantIds: [], cause: { type: 'receipt', documentId } }).success).toBe(false);
    });

    it('từ chối cause thiếu documentId hay documentId không phải uuid', () => {
      expect(schema.safeParse({ variantIds: [], cause: { type: 'stocktake' } }).success).toBe(false);
      expect(schema.safeParse({ variantIds: [], cause: { type: 'stocktake', documentId: 'PK-0001' } }).success).toBe(false);
    });
  });
});
