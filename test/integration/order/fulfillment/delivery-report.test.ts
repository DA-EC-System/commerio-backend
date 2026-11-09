import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EVENT_SCHEMAS } from '#src/modules/core/platform/domain/events.ts';
import { reportDeliveryFailed, reportDelivered } from '#src/modules/order/fulfillment/service/delivery.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { testPool } from '../../helpers/db.ts';
import { outboxOf, seedPackage, setOrderLineMoney, setOrderShipping } from './helpers.ts';

const DELIVERED = EVENT_SCHEMAS['fulfillment.package_delivered'];
const FAILED = EVENT_SCHEMAS['fulfillment.package_delivery_failed'];
const T = new Date('2026-11-10T09:00:00Z');

const parsedDelivered = (payloads: Record<string, unknown>[]) => payloads.map((p) => DELIVERED.parse(p));

interface Ctx {
  companyId: string;
  variantId: string;
  packageId: string;
  orderId: string;
  lineIds: string[];
}

/** Một đơn sàn + kiện đã giao (dòng đã trừ, chốt giá vốn), tồn không cần (kiện đã rời kho). */
async function seed(ctx: {
  status: 'delivered' | 'in_transit';
  lines: { quantity: number; unitCost?: string; noVariant?: boolean }[];
  handoverSource: 'scan' | 'marketplace' | 'before_cutoff';
}): Promise<Ctx> {
  const { companyId } = await createCompany();
  const { variantId } = await createVariant(companyId);
  const lines = ctx.lines.map((l) => ({
    variantId: l.noVariant ? null : variantId,
    quantity: l.quantity,
    ...(l.unitCost ? { unitCost: l.unitCost } : {}),
  }));
  const shopId = randomUUID();
  const p = await seedPackage(companyId, {
    status: ctx.status,
    lines,
    handoverSource: ctx.handoverSource,
    handedOverAt: T,
    deliveredAt: ctx.status === 'delivered' ? T : null,
    shopId,
  });
  // Ghi shop_id thật vào kiện và đơn (createOrder đặt randomUUID), để payload có shopId.
  await testPool().query('update "order".orders set shop_id = $2 where id = $1', [p.orderId, shopId]);
  await testPool().query('update "order".packages set shop_id = $2 where id = $1', [p.packageId, shopId]);
  return { companyId, variantId, packageId: p.packageId, orderId: p.orderId, lineIds: p.lineIds };
}

const line = (patch: { quantity?: number; unitCost?: string; noVariant?: boolean } = {}) => ({
  quantity: 1,
  ...patch,
});

const ship = { shippingFee: '15000.00', shippingFeeOriginal: '30000.00', shippingFeeDiscountPlatform: '12000.00' };

describe('lõi báo giao xong cho finance (spec 199c §5.3)', () => {
  it('phát package_delivered đủ tiền, kiện đầu của đơn mang ship cấp đơn, đặt delivery_posted_at', async () => {
    const s = await seed({ status: 'delivered', lines: [line({ unitCost: '60000.00' })], handoverSource: 'scan' });
    await setOrderShipping(s.orderId, ship);
    await setOrderLineMoney(s.lineIds[0]!, { unitPrice: '100000.00', sellerDiscount: '10000.00', platformDiscount: '5000.00' });

    expect(await withCompany(s.companyId, () => reportDelivered(s.packageId))).toBe(true);
    const p = parsedDelivered(await outboxOf(s.orderId, 'fulfillment.package_delivered'))[0]!;
    expect(p.deliveredAt).toBe(T.toISOString());
    expect(p.lines[0]).toEqual({ variantId: s.variantId, quantity: 1, unitPrice: '90000.00', unitCost: '60000.00' });
    expect(p.platformSubsidy).toBe('17000.00');
    expect(p.shippingIncome).toBe('15000.00');
    expect(p.shippingCost).toBe('30000.00');

    const { rows } = await testPool().query<{ delivery_posted_at: Date | null }>(
      'select delivery_posted_at from "order".packages where id = $1',
      [s.packageId],
    );
    expect(rows[0]!.delivery_posted_at).not.toBeNull();
  });

  it('gọi lần hai trả false, không phát thêm', async () => {
    const s = await seed({ status: 'delivered', lines: [line({ unitCost: '60000.00' })], handoverSource: 'scan' });
    await setOrderShipping(s.orderId, { shippingFee: '15000.00', shippingFeeOriginal: null, shippingFeeDiscountPlatform: null });
    await withCompany(s.companyId, async () => {
      expect(await reportDelivered(s.packageId)).toBe(true);
      expect(await reportDelivered(s.packageId)).toBe(false);
    });
    expect((await outboxOf(s.orderId, 'fulfillment.package_delivered')).length).toBe(1);
  });

  it('kiện còn dòng hoãn trừ (đã ghép, chưa trừ, không before_cutoff) → false, chưa phát', async () => {
    const s = await seed({ status: 'delivered', lines: [line()], handoverSource: 'marketplace' });
    await setOrderShipping(s.orderId, { shippingFee: '15000.00', shippingFeeOriginal: null, shippingFeeDiscountPlatform: null });
    expect(await withCompany(s.companyId, () => reportDelivered(s.packageId))).toBe(false);
    expect(await outboxOf(s.orderId, 'fulfillment.package_delivered')).toHaveLength(0);
  });

  it('kiện before_cutoff → phát với unitCost null', async () => {
    const s = await seed({ status: 'delivered', lines: [line()], handoverSource: 'before_cutoff' });
    await setOrderShipping(s.orderId, { shippingFee: '15000.00', shippingFeeOriginal: null, shippingFeeDiscountPlatform: null });
    expect(await withCompany(s.companyId, () => reportDelivered(s.packageId))).toBe(true);
    expect(parsedDelivered(await outboxOf(s.orderId, 'fulfillment.package_delivered'))[0]!.lines[0]!.unitCost).toBeNull();
  });

  it('dòng chưa ghép SKU → variantId null, unitCost null, unitPrice đủ', async () => {
    const s = await seed({ status: 'delivered', lines: [line({ unitCost: '60000.00' }), line({ noVariant: true })], handoverSource: 'scan' });
    await setOrderShipping(s.orderId, { shippingFee: '15000.00', shippingFeeOriginal: null, shippingFeeDiscountPlatform: null });
    await setOrderLineMoney(s.lineIds[1]!, { unitPrice: '90000.00', sellerDiscount: '0.00', platformDiscount: '0.00' });
    expect(await withCompany(s.companyId, () => reportDelivered(s.packageId))).toBe(true);
    const p = parsedDelivered(await outboxOf(s.orderId, 'fulfillment.package_delivered'))[0]!;
    expect(p.lines).toHaveLength(2);
    expect(p.lines[1]).toMatchObject({ variantId: null, quantity: 1, unitCost: null, unitPrice: '90000.00' });
  });

  it('kiện của đơn đã có kiện khác báo giao → ship "0.00"', async () => {
    const s = await seed({ status: 'delivered', lines: [line({ unitCost: '60000.00' })], handoverSource: 'scan' });
    await setOrderShipping(s.orderId, ship);
    await testPool().query(
      `insert into "order".packages (company_id, code, order_id, shop_id, status, handed_over_at, handover_source, delivery_posted_at, version)
       values ($1, $2, $3, $4, 'delivered', now(), 'marketplace', now(), 0)`,
      [s.companyId, `KH-${randomUUID().slice(0, 8)}`, s.orderId, randomUUID()],
    );
    expect(await withCompany(s.companyId, () => reportDelivered(s.packageId))).toBe(true);
    const p = parsedDelivered(await outboxOf(s.orderId, 'fulfillment.package_delivered'))[0]!;
    expect(p.shippingIncome).toBe('0.00');
    expect(p.shippingCost).toBe('0.00');
  });

  it('reportDeliveryFailed phát payload có reason', async () => {
    const s = await seed({ status: 'in_transit', lines: [line({ unitCost: '60000.00' })], handoverSource: 'scan' });
    await withCompany(s.companyId, () => reportDeliveryFailed({ id: s.packageId, orderId: s.orderId }, 'Khách không nghe máy'));
    const payloads = (await outboxOf(s.orderId, 'fulfillment.package_delivery_failed')).map((p) => FAILED.parse(p));
    expect(payloads[0]!.reason).toBe('Khách không nghe máy');
  });
});
