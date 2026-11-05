import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ingestMarketplaceOrder, type PlatformOrder } from '#src/modules/order/index.ts';
import { setStockPort } from '#src/modules/order/fulfillment/service/stock-port.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { noLineInfo, noOrderInfo, noShipping } from './helpers.ts';

let companyId: string;
let sku: string;
let variantId: string;
const shopId = randomUUID();

beforeAll(async () => {
  ({ companyId } = await createCompany());
  ({ sku, variantId } = await createVariant(companyId));
});

const reserve = vi.fn(async () => ({ reserved: true }));
const release = vi.fn(async () => {});
afterEach(() => {
  setStockPort();
  reserve.mockClear();
  release.mockClear();
});

let seq = 0;
function remote(overrides: Partial<PlatformOrder> = {}, lineStatus: PlatformOrder['lines'][number]['status'] = 'pending'): PlatformOrder {
  seq += 1;
  return {
    shopId,
    externalOrderId: `LZ-${Date.now()}-${seq}`,
    rawStatus: 'pending',
    paid: true,
    isCod: true,
    placedAt: new Date('2026-10-29T07:00:00Z'),
    shipBy: new Date('2026-11-04T16:59:19Z'),
    shippingAddress: { name: 'K***h', phone: '84****22', address: 'P**a' },
    shippingFee: '15000',
    cancelRequested: false,
    info: noOrderInfo,
    lines: [
      {
        externalLineId: `${seq}-1`,
        variantId,
        sellerSku: sku,
        productName: 'Áo thun',
        unitPrice: '100000',
        sellerDiscount: '10000',
        platformDiscount: '5000',
        packageCode: `FP-${seq}`,
        trackingCode: null,
        rawStatus: 'pending',
        status: lineStatus,
        info: noLineInfo,
        shipping: noShipping,
      },
    ],
    ...overrides,
  };
}

const ingest = (o: PlatformOrder) => withCompany(companyId, () => ingestMarketplaceOrder(o));
const one = async (sql: string, params: unknown[]) => (await testPool().query(sql, params)).rows[0];
const all = async (sql: string, params: unknown[]) => (await testPool().query(sql, params)).rows;

async function orderOf(orderId: string) {
  return one(
    `select status, outcome, raw_marketplace_status, is_cod, subtotal, total, ship_by, cancel_requested, cancelling,
            platform_cancelled, needs_attention, code from "order".orders where id = $1`,
    [orderId],
  );
}
const packagesOf = (orderId: string) =>
  all(
    `select id, status, platform_package_code, tracking_code, needs_open, open_purpose, needs_attention
       from "order".packages where order_id = $1 order by created_at`,
    [orderId],
  );
const transitionsOf = (entityId: string) =>
  all(`select from_state, to_state, action, source from core.state_transitions where entity_id = $1 order by id`, [entityId]);
const eventsOf = (orderId: string) =>
  all(`select type, payload from core.outbox_messages where payload->>'orderId' = $1 order by id`, [orderId]);

describe('nhận đơn sàn (#105)', () => {
  it('đơn mới đã trả: đơn processing, dòng, kiện theo mã kiện sàn, giữ hàng, lịch sử, sự kiện', async () => {
    setStockPort({ reserve, release });
    const o = remote();
    const res = await ingest(o);
    expect(res.created).toBe(true);

    expect(await orderOf(res.orderId)).toMatchObject({
      status: 'processing',
      raw_marketplace_status: 'pending',
      is_cod: true,
      subtotal: '100000.00',
      total: '100000.00',
      code: expect.stringMatching(/^DH-\d{6}$/),
    });
    const lines = await all(
      `select variant_id, external_line_id, external_sku, sku, quantity, unit_price, line_total from "order".order_lines where order_id = $1`,
      [res.orderId],
    );
    expect(lines).toEqual([
      { variant_id: variantId, external_line_id: o.lines[0]!.externalLineId, external_sku: sku, sku, quantity: 1, unit_price: '100000.00', line_total: '85000.00' },
    ]);
    const [pkg] = await packagesOf(res.orderId);
    expect(pkg).toMatchObject({ status: 'reserved', platform_package_code: o.lines[0]!.packageCode });
    expect(reserve).toHaveBeenCalledWith(pkg.id, [{ variantId, quantity: 1 }]);
    expect(await all(`select reserved_qty from "order".package_lines where package_id = $1`, [pkg.id])).toEqual([{ reserved_qty: 1 }]);

    expect(await transitionsOf(res.orderId)).toEqual([
      { from_state: null, to_state: 'unpaid', action: 'create', source: 'marketplace' },
      { from_state: 'unpaid', to_state: 'processing', action: 'pay', source: 'marketplace' },
    ]);
    expect(await transitionsOf(pkg.id)).toEqual([{ from_state: null, to_state: 'reserved', action: 'create', source: 'marketplace' }]);
    expect((await eventsOf(res.orderId)).map((e) => e.type)).toEqual([
      'sales.order_created',
      'fulfillment.package_status_changed',
      'sales.order_status_changed',
    ]);
  });

  it('kéo lại cùng đơn không sinh dòng, kiện, lịch sử, sự kiện mới', async () => {
    const o = remote();
    const first = await ingest(o);
    const before = (await eventsOf(first.orderId)).length;
    const again = await ingest(o);
    expect(again).toEqual({ orderId: first.orderId, created: false, changed: false });
    expect(await all(`select 1 from "order".order_lines where order_id = $1`, [first.orderId])).toHaveLength(1);
    expect(await packagesOf(first.orderId)).toHaveLength(1);
    expect(await eventsOf(first.orderId)).toHaveLength(before);
  });

  it('kéo lại: dòng, đơn, kiện nhận thông tin mới; chỉ thông tin đổi thì không phát sự kiện, không tính là đổi (#260 AC-S1)', async () => {
    const o = remote();
    const first = await ingest(o);
    const before = (await eventsOf(first.orderId)).length;
    const line = o.lines[0]!;
    const again = await ingest({
      ...o,
      shippingAddress: { ...o.shippingAddress!, ward: 'Phường Tân Sơn Hòa', postCode: null, raw: { city: 'Phường Tân Sơn Hòa' } },
      info: { ...noOrderInfo, platformPaymentMethod: 'COD', buyerNote: 'Giao giờ hành chính', shippingFeeOriginal: '20000' },
      lines: [
        {
          ...line,
          info: { ...noLineInfo, thumbnailUrl: 'https://img/a.jpg', externalSkuId: '1175', paidPrice: '85000', cancelReason: 'Đổi ý', cancelInitiator: 'buyer', cancelKind: 'cancellation' },
          shipping: { ...noShipping, shipmentProvider: 'J&T VN', shippingProviderType: 'standard' },
        },
      ],
    });
    expect(again).toEqual({ orderId: first.orderId, created: false, changed: false });
    expect(await eventsOf(first.orderId)).toHaveLength(before);
    expect(await one(`select platform_payment_method, buyer_note, shipping_fee_original, shipping_address->>'ward' as ward, payment_method from "order".orders where id = $1`, [first.orderId])).toEqual({
      platform_payment_method: 'COD',
      buyer_note: 'Giao giờ hành chính',
      shipping_fee_original: '20000.00',
      ward: 'Phường Tân Sơn Hòa',
      payment_method: null,
    });
    expect(
      await one(`select thumbnail_url, external_sku_id, paid_price, cancel_reason, cancel_initiator, cancel_kind, variant_id, unit_price from "order".order_lines where order_id = $1`, [first.orderId]),
    ).toEqual({
      thumbnail_url: 'https://img/a.jpg',
      external_sku_id: '1175',
      paid_price: '85000.00',
      cancel_reason: 'Đổi ý',
      cancel_initiator: 'buyer',
      cancel_kind: 'cancellation',
      variant_id: variantId,
      unit_price: '100000.00',
    });
    expect(await one(`select shipment_provider, shipping_provider_type, version from "order".packages where order_id = $1`, [first.orderId])).toMatchObject({
      shipment_provider: 'J&T VN',
      shipping_provider_type: 'standard',
    });
    // Kéo lần ba không đổi gì: không ghi, version đơn, dòng, kiện đứng yên.
    const versions = async () =>
      one(
        `select (select version from "order".orders where id = $1) as o, (select version from "order".order_lines where order_id = $1) as l,
                (select version from "order".packages where order_id = $1) as p`,
        [first.orderId],
      );
    const v1 = await versions();
    await ingest({ ...o, info: { ...noOrderInfo, platformPaymentMethod: 'COD', buyerNote: 'Giao giờ hành chính', shippingFeeOriginal: '20000' },
      shippingAddress: { ...o.shippingAddress!, ward: 'Phường Tân Sơn Hòa', postCode: null, raw: { city: 'Phường Tân Sơn Hòa' } },
      lines: [{ ...line, info: { ...noLineInfo, thumbnailUrl: 'https://img/a.jpg', externalSkuId: '1175', paidPrice: '85000', cancelReason: 'Đổi ý', cancelInitiator: 'buyer', cancelKind: 'cancellation' },
        shipping: { ...noShipping, shipmentProvider: 'J&T VN', shippingProviderType: 'standard' } }] });
    expect(await versions()).toEqual(v1);
  });

  it('chưa nối cổng tồn thật: kiện thiếu hàng; dòng chưa ghép SKU không gọi giữ hàng', async () => {
    const res = await ingest(remote());
    expect((await packagesOf(res.orderId))[0].status).toBe('backordered');

    setStockPort({ reserve, release });
    const o = remote();
    o.lines[0]!.variantId = null;
    const unmapped = await ingest(o);
    expect((await packagesOf(unmapped.orderId))[0].status).toBe('backordered');
    expect(reserve).not.toHaveBeenCalled();
  });

  it('đơn chưa trả giữ unpaid; lần sau sàn báo đã trả thì sang processing', async () => {
    const o = remote({ paid: false, rawStatus: 'unpaid' });
    const res = await ingest(o);
    expect((await orderOf(res.orderId)).status).toBe('unpaid');
    expect(await ingest({ ...o, paid: true, rawStatus: 'pending' })).toMatchObject({ changed: true });
    expect((await orderOf(res.orderId)).status).toBe('processing');
  });

  it('sàn nhảy cóc: kiện đi thẳng tới trạng thái sàn báo, ghi một dòng lịch sử, cập nhật mã vận đơn', async () => {
    setStockPort({ reserve, release });
    const o = remote();
    const res = await ingest(o);
    const shipped = structuredClone(o);
    shipped.rawStatus = 'shipped';
    shipped.lines[0] = { ...shipped.lines[0]!, rawStatus: 'shipped', status: 'in_transit', trackingCode: 'JNT123' };
    await ingest(shipped);
    const [pkg] = await packagesOf(res.orderId);
    expect(pkg).toMatchObject({ status: 'in_transit', tracking_code: 'JNT123' });
    expect((await transitionsOf(pkg.id)).at(-1)).toEqual({ from_state: 'reserved', to_state: 'in_transit', action: 'platform_sync', source: 'marketplace' });
    expect((await orderOf(res.orderId)).raw_marketplace_status).toBe('shipped');

    shipped.lines[0]!.status = 'delivered';
    await ingest(shipped);
    expect((await transitionsOf(pkg.id)).at(-1)).toMatchObject({ from_state: 'in_transit', to_state: 'delivered', action: 'deliver' });
  });

  it('sàn báo trạng thái không áp được hay giá trị lạ: cờ cần xử lý, trạng thái giữ nguyên', async () => {
    const o = remote({}, 'delivered');
    const res = await ingest(o);
    const back = structuredClone(o);
    back.lines[0]!.status = 'packed';
    await ingest(back);
    expect((await packagesOf(res.orderId))[0]).toMatchObject({ status: 'delivered', needs_attention: true });

    const odd = remote();
    odd.lines[0]!.status = null;
    odd.lines[0]!.rawStatus = 'something_new';
    const r2 = await ingest(odd);
    expect((await orderOf(r2.orderId)).needs_attention).toBe(true);
  });

  it('hoàn hàng thất bại: kiện ở returning, cờ cần xử lý', async () => {
    const o = remote();
    const res = await ingest(o);
    const failed = structuredClone(o);
    failed.lines[0]!.status = 'in_transit';
    await ingest(failed);
    failed.lines[0]!.status = 'returning';
    await ingest(failed);
    failed.lines[0]!.status = 'return_failed';
    await ingest(failed);
    expect((await packagesOf(res.orderId))[0]).toMatchObject({ status: 'returning', needs_attention: true });
  });

  it('sàn huỷ khi chưa đóng gói: đơn, kiện huỷ, nhả hàng, phát sales.order_cancelled', async () => {
    setStockPort({ reserve, release });
    const o = remote();
    const res = await ingest(o);
    const cancelled = structuredClone(o);
    cancelled.rawStatus = 'canceled';
    cancelled.lines[0]!.status = 'cancelled';
    await ingest(cancelled);
    expect((await orderOf(res.orderId)).status).toBe('cancelled');
    const [pkg] = await packagesOf(res.orderId);
    expect(pkg.status).toBe('cancelled');
    expect(release).toHaveBeenCalledWith(pkg.id, [{ variantId, quantity: 1 }]);
    expect((await transitionsOf(res.orderId)).at(-1)).toMatchObject({ to_state: 'cancelled', action: 'platform_cancel' });
    const cancelEvent = (await eventsOf(res.orderId)).find((e) => e.type === 'sales.order_cancelled');
    expect(cancelEvent?.payload).toMatchObject({ source: 'marketplace', by: 'platform' });
  });

  it('sàn huỷ khi kiện đã đóng gói: kiện chờ mở, đơn mang cờ đang huỷ', async () => {
    const o = remote({}, 'packed');
    const res = await ingest(o);
    const cancelled = structuredClone(o);
    cancelled.lines[0]!.status = 'cancelled';
    await ingest(cancelled);
    expect(await orderOf(res.orderId)).toMatchObject({ status: 'processing', cancelling: true });
    expect((await packagesOf(res.orderId))[0]).toMatchObject({ status: 'packed', needs_open: true, open_purpose: 'cancel' });
  });

  it('sàn huỷ khi kiện đã rời kho: cờ sàn đã huỷ, kiện chạy tiếp', async () => {
    const o = remote({}, 'in_transit');
    const res = await ingest(o);
    const cancelled = structuredClone(o);
    cancelled.lines[0]!.status = 'cancelled';
    await ingest(cancelled);
    expect(await orderOf(res.orderId)).toMatchObject({ status: 'processing', platform_cancelled: true });
    expect((await packagesOf(res.orderId))[0].status).toBe('in_transit');
  });

  it('khách xin huỷ bật cờ, sàn bỏ thì tắt cờ', async () => {
    const o = remote({ cancelRequested: true });
    const res = await ingest(o);
    expect((await orderOf(res.orderId)).cancel_requested).toBe(true);
    await ingest({ ...o, cancelRequested: false });
    expect((await orderOf(res.orderId)).cancel_requested).toBe(false);
  });

  it('kiện tạm (sàn chưa chia kiện) nhận mã kiện sàn ở lần kéo sau, không sinh kiện mới', async () => {
    const o = remote();
    o.lines[0]!.packageCode = null;
    const res = await ingest(o);
    const coded = structuredClone(o);
    coded.lines[0]!.packageCode = 'FP-LATE';
    await ingest(coded);
    const pkgs = await packagesOf(res.orderId);
    expect(pkgs).toHaveLength(1);
    expect(pkgs[0].platform_package_code).toBe('FP-LATE');
  });

  it('hai lần kéo chạy đua cùng một đơn mới chỉ tạo một đơn', async () => {
    const o = remote();
    const results = await Promise.all([ingest(o), ingest(o)]);
    expect(new Set(results.map((r) => r.orderId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await all(`select 1 from "order".order_lines where order_id = $1`, [results[0]!.orderId])).toHaveLength(1);
  });
});
