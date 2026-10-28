import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canReceive, effectivePermissions, toMessage } from '#src/modules/core/notification/domain/rules.ts';
import type { EventEnvelope, EventType } from '#src/modules/core/platform/index.ts';
import type { CompanyAccess } from '#src/shared/auth/company-access.ts';

const id = () => randomUUID();
const envelope = (type: EventType, payload: unknown, aggregateId = id()) =>
  ({ eventId: id(), type, companyId: id(), aggregateId, occurredAt: '2026-10-18T09:00:00.000+07:00', payload }) as EventEnvelope<EventType>;

const ALL_MODULES = ['sales', 'fulfillment', 'payment', 'finance', 'inventory', 'purchasing'];
const access = (permissions: string[], enabledModules = ALL_MODULES): CompanyAccess => ({
  companyStatus: 'active',
  membershipStatus: 'active',
  passwordChangedAt: null,
  permissions,
  enabledModules,
});
const perms = (...codes: string[]) => effectivePermissions(access(codes));

// Quyền của bốn vai trò có sẵn liên quan tới thông báo (đo trên DB, ground-truth p3-role-perms.txt).
const ROLES = {
  ceo: perms('sales.order.view', 'finance.invoice.view', 'inventory.stock.view', 'purchasing.request.approve'),
  admin: perms('sales.order.view', 'inventory.stock.view'),
  sale: perms('sales.order.view'),
  warehouse: perms('inventory.stock.view'),
};

describe('bảng loại sự kiện → quyền (D11, plan A1, A2)', () => {
  const table: [EventType, (keyof typeof ROLES)[]][] = [
    ['sales.order_created', ['ceo', 'admin', 'sale']],
    ['fulfillment.order_status_changed', ['ceo', 'admin', 'sale']],
    ['payment.succeeded', ['ceo', 'admin', 'sale']],
    ['inventory.below_threshold', ['ceo', 'admin', 'warehouse']],
    ['inventory.receipt_posted', ['ceo', 'admin', 'warehouse']],
    ['purchasing.order_submitted', ['ceo']],
  ];
  it.each(table)('%s tới đúng vai trò có sẵn', (type, receivers) => {
    for (const role of Object.keys(ROLES) as (keyof typeof ROLES)[]) {
      expect(canReceive(ROLES[role], type), `${role} ${type}`).toBe(receivers.includes(role));
    }
  });

  it('thanh toán: chỉ finance.invoice.view cũng nhận (A1 "hoặc")', () => {
    expect(canReceive(perms('finance.invoice.view'), 'payment.succeeded')).toBe(true);
    expect(canReceive(perms('finance.invoice.view'), 'sales.order_created')).toBe(false);
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
    expect(canReceive(noPurchasing, 'purchasing.order_submitted')).toBe(false);
    expect(canReceive(noPurchasing, 'sales.order_created')).toBe(true);
  });
});

describe('toMessage: chỉ gửi trường cho phép, tiền là số nguyên đồng (plan A4)', () => {
  it('payment.succeeded bỏ mã giao dịch, cổng và aggregateId; tiền làm tròn nửa lên', () => {
    const orderId = id();
    const transactionId = id();
    const e = envelope('payment.succeeded', { orderId, paymentTransactionId: transactionId, gateway: 'vnpay', amount: '150000.50' }, transactionId);
    const message = toMessage(e)!;
    expect(message).toEqual({ eventId: e.eventId, type: 'payment.succeeded', occurredAt: e.occurredAt, payload: { orderId, amount: 150001 } });
    expect(JSON.stringify(message)).not.toContain(transactionId);
    expect(JSON.stringify(message)).not.toContain(e.companyId!);
  });

  it('đơn mới: tổng tiền số nguyên', () => {
    const orderId = id();
    const payload = toMessage(envelope('sales.order_created', { orderId, code: 'DH-0001', source: 'manual', total: '150000.00' }))!.payload;
    expect(payload).toEqual({ orderId, code: 'DH-0001', source: 'manual', total: 150000 });
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
    const purchaseOrderId = id();
    expect(toMessage(envelope('fulfillment.order_status_changed', { orderId, from: 'confirmed', to: 'picking', isShortStock: true }))!.payload).toEqual({
      orderId,
      from: 'confirmed',
      to: 'picking',
      isShortStock: true,
    });
    expect(toMessage(envelope('inventory.below_threshold', { variantId, available: 1, minQty: 5 }))!.payload).toEqual({ variantId, available: 1, minQty: 5 });
    expect(toMessage(envelope('purchasing.order_submitted', { purchaseOrderId, code: 'PO-0001' }))!.payload).toEqual({ purchaseOrderId, code: 'PO-0001' });
  });

  it('loại ngoài bảng → null (không gửi)', () => {
    expect(toMessage(envelope('inventory.stock_changed', { variantId: id(), onHand: 1, reserved: 0, available: 1 }))).toBeNull();
  });
});
