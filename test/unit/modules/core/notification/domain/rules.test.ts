import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canReceive, effectivePermissions, NOTIFIED_TYPES, toMessage } from '#src/modules/core/notification/domain/rules.ts';
import type { EventEnvelope, EventType } from '#src/modules/core/platform/index.ts';
import type { CompanyAccess } from '#src/shared/auth/company-access.ts';

const id = () => randomUUID();
const envelope = (type: EventType, payload: unknown, aggregateId = id()) =>
  ({ eventId: id(), type, companyId: id(), aggregateId, occurredAt: '2026-10-18T09:00:00.000+07:00', payload }) as EventEnvelope<EventType>;

const ALL_MODULES = ['sales', 'fulfillment', 'payment', 'finance', 'inventory', 'purchasing', 'channel'];
const access = (permissions: string[], enabledModules = ALL_MODULES): CompanyAccess => ({
  companyStatus: 'active',
  membershipStatus: 'active',
  passwordChangedAt: null,
  permissions,
  enabledModules,
});
const perms = (...codes: string[]) => effectivePermissions(access(codes));

// Quyền của bốn vai trò có sẵn liên quan tới thông báo (đo trên DB, ground-truth p3-role-perms.txt).
// Thêm quyền của sự kiện mô hình mới theo core/access/domain/catalog.ts (#216).
const ROLES = {
  ceo: perms(
    'sales.order.view',
    'finance.invoice.view',
    'inventory.stock.view',
    'purchasing.request.approve',
    'sales.return.view',
    'fulfillment.order.process',
    'channel.shop.view',
  ),
  admin: perms('sales.order.view', 'inventory.stock.view', 'sales.return.view', 'channel.shop.view'),
  sale: perms('sales.order.view', 'sales.return.view', 'channel.shop.view'),
  warehouse: perms('inventory.stock.view', 'sales.return.view', 'fulfillment.order.process'),
};

describe('bảng loại sự kiện → quyền (D11, plan A1, A2)', () => {
  const table: [EventType, (keyof typeof ROLES)[]][] = [
    ['sales.order_created', ['ceo', 'admin', 'sale']],
    ['sales.order_status_changed', ['ceo', 'admin', 'sale']],
    ['fulfillment.package_status_changed', ['ceo', 'admin', 'sale', 'warehouse']],
    ['fulfillment.package_delivery_failed', ['ceo', 'admin', 'sale', 'warehouse']],
    ['fulfillment.package_lost', ['ceo', 'admin', 'sale', 'warehouse']],
    ['sales.return_status_changed', ['ceo', 'admin', 'sale', 'warehouse']],
    ['channel.shop_status_changed', ['ceo', 'admin', 'sale']],
    ['channel.listing_sync_changed', ['ceo', 'admin', 'sale']],
    ['inventory.below_threshold', ['ceo', 'admin', 'warehouse']],
    ['inventory.receipt_posted', ['ceo', 'admin', 'warehouse']],
    ['purchasing.request_submitted', ['ceo']],
  ];
  it.each(table)('%s tới đúng vai trò có sẵn', (type, receivers) => {
    for (const role of Object.keys(ROLES) as (keyof typeof ROLES)[]) {
      expect(canReceive(ROLES[role], type), `${role} ${type}`).toBe(receivers.includes(role));
    }
  });

  it('kiện: chỉ fulfillment.order.process cũng nhận (D1 "hoặc")', () => {
    expect(canReceive(perms('fulfillment.order.process'), 'fulfillment.package_lost')).toBe(true);
    expect(canReceive(perms('fulfillment.order.process'), 'sales.order_status_changed')).toBe(false);
  });

  it('hai loại cũ không tới ai, consumer không nghe (AC3)', () => {
    expect(canReceive(ROLES.ceo, 'payment.succeeded')).toBe(false);
    expect(canReceive(ROLES.ceo, 'fulfillment.order_status_changed')).toBe(false);
    expect(toMessage(envelope('payment.succeeded', { orderId: id(), paymentTransactionId: id(), gateway: 'vnpay', amount: '150000.00' }))).toBeNull();
    expect(toMessage(envelope('fulfillment.order_status_changed', { orderId: id(), from: 'confirmed', to: 'picking', isShortStock: false }))).toBeNull();
    expect([...NOTIFIED_TYPES].sort()).toEqual(
      [
        'sales.order_created',
        'inventory.below_threshold',
        'inventory.receipt_posted',
        'purchasing.request_submitted',
        'sales.order_status_changed',
        'fulfillment.package_status_changed',
        'fulfillment.package_delivery_failed',
        'fulfillment.package_lost',
        'sales.return_status_changed',
        'channel.shop_status_changed',
        'channel.listing_sync_changed',
      ].sort(),
    );
  });

  it('tắt phân hệ channel thì không nhận gian hàng, listing', () => {
    const noChannel = effectivePermissions(access(['channel.shop.view', 'sales.order.view'], ALL_MODULES.filter((m) => m !== 'channel')));
    expect(canReceive(noChannel, 'channel.shop_status_changed')).toBe(false);
    expect(canReceive(noChannel, 'channel.listing_sync_changed')).toBe(false);
    expect(canReceive(noChannel, 'sales.order_status_changed')).toBe(true);
  });

  it('loại không thuộc UC-NO-01 không tới ai, kể cả CEO', () => {
    for (const type of ['inventory.stock_changed', 'inventory.issue_posted', 'finance.invoice_posted'] as const) {
      expect(canReceive(ROLES.ceo, type)).toBe(false);
    }
  });

  it('quyền của phân hệ đang tắt không tính', () => {
    const noPurchasing = effectivePermissions(
      access(['sales.order.view', 'purchasing.request.approve'], ALL_MODULES.filter((m) => m !== 'purchasing')),
    );
    expect(canReceive(noPurchasing, 'purchasing.request_submitted')).toBe(false);
    expect(canReceive(noPurchasing, 'sales.order_created')).toBe(true);
  });
});

describe('toMessage: chỉ gửi trường cho phép, tiền là số nguyên đồng (plan A4)', () => {
  it('đơn mới: tổng tiền số nguyên, làm tròn nửa lên; không lộ aggregateId, companyId', () => {
    const orderId = id();
    const e = envelope('sales.order_created', { orderId, code: 'DH-0001', source: 'manual', total: '150000.50' });
    const message = toMessage(e)!;
    expect(message).toEqual({
      eventId: e.eventId,
      type: 'sales.order_created',
      occurredAt: e.occurredAt,
      payload: { orderId, code: 'DH-0001', source: 'manual', total: 150001 },
    });
    expect(JSON.stringify(message)).not.toContain(e.aggregateId);
    expect(JSON.stringify(message)).not.toContain(e.companyId!);
  });

  it('bảy loại mới: payload đúng trường, sự kiện thừa trường không lọt (AC2)', () => {
    const [orderId, packageId, returnId, shopId, listingId] = [id(), id(), id(), id(), id()];
    const cases: [EventType, Record<string, unknown>, Record<string, unknown>][] = [
      [
        'sales.order_status_changed',
        { orderId, code: 'DH-000001', from: 'unpaid', to: 'processing', flags: ['unmapped_sku'], extra: 'x' },
        { orderId, code: 'DH-000001', from: 'unpaid', to: 'processing', flags: ['unmapped_sku'] },
      ],
      [
        'fulfillment.package_status_changed',
        { packageId, orderId, from: 'reserved', to: 'packed', extra: 'x' },
        { packageId, orderId, from: 'reserved', to: 'packed' },
      ],
      [
        'fulfillment.package_delivery_failed',
        { packageId, orderId, reason: 'Khách không nghe máy', extra: 'x' },
        { packageId, orderId, reason: 'Khách không nghe máy' },
      ],
      ['fulfillment.package_lost', { packageId, orderId, claimCode: 'KN-1', extra: 'x' }, { packageId, orderId, claimCode: 'KN-1' }],
      ['sales.return_status_changed', { returnId, orderId, from: null, to: 'requested', extra: 'x' }, { returnId, orderId, from: null, to: 'requested' }],
      ['channel.shop_status_changed', { shopId, from: 'active', to: 'needs_reauth', extra: 'x' }, { shopId, from: 'active', to: 'needs_reauth' }],
      [
        'channel.listing_sync_changed',
        { shopId, listingId, stockSync: 'pending', priceSync: 'synced', status: 'live', extra: 'x' },
        { shopId, listingId, stockSync: 'pending', priceSync: 'synced', status: 'live' },
      ],
    ];
    for (const [type, payload, expected] of cases) {
      const e = envelope(type, payload);
      const message = toMessage(e)!;
      expect(message, type).not.toBeNull();
      expect(message.payload, type).toEqual(expected);
      expect(JSON.stringify(message), type).not.toContain(e.aggregateId);
      expect(JSON.stringify(message), type).not.toContain(e.companyId!);
    }
  });

  it('phiếu nhập không gửi dòng phiếu', () => {
    const receiptId = id();
    const payload = toMessage(
      envelope('inventory.receipt_posted', { receiptId, number: 'PN-0001', kind: 'purchase', lines: [{ variantId: id(), quantity: 3 }] }),
    )!.payload;
    expect(payload).toEqual({ receiptId, number: 'PN-0001', kind: 'purchase' });
  });

  it('các loại còn lại giữ đủ trường của danh mục', () => {
    const orderId = id();
    const variantId = id();
    const requestId = id();
    expect(toMessage(envelope('sales.order_status_changed', { orderId, code: 'DH-1', from: null, to: 'unpaid', flags: [] }))!.payload).toEqual({
      orderId,
      code: 'DH-1',
      from: null,
      to: 'unpaid',
      flags: [],
    });
    expect(toMessage(envelope('inventory.below_threshold', { variantId, available: 1, minQty: 5 }))!.payload).toEqual({ variantId, available: 1, minQty: 5 });
    expect(toMessage(envelope('purchasing.request_submitted', { requestId, number: 'DN-000001' }))!.payload).toEqual({ requestId, number: 'DN-000001' });
  });

  it('loại ngoài bảng → null (không gửi)', () => {
    expect(toMessage(envelope('inventory.stock_changed', { variantId: id(), onHand: 1, reserved: 0, available: 1 }))).toBeNull();
  });
});
