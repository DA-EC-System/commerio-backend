import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { Order, OrderSummaryPage } from '#src/modules/order/sales/api/schemas.ts';
import { ingestMarketplaceOrder, type PlatformOrder } from '#src/modules/order/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { createOrder } from '../../helpers/sales.ts';
import { noLineInfo, noOrderInfo, noShipping } from './helpers.ts';

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
let variantId: string;
let sku: string;
let shopId: string;
const ids: Record<string, string> = {};

function order(id: string, lines: { variantId: string | null; status: PlatformOrder['lines'][number]['status']; pkg: string }[], o: Partial<PlatformOrder> = {}) {
  return {
    shopId,
    externalOrderId: id,
    rawStatus: lines.map((l) => l.status).join(','),
    paid: true,
    isCod: true,
    placedAt: new Date('2026-10-29T03:00:00Z'),
    shipBy: null,
    shippingAddress: { name: 'K***h', phone: '84****22', address: 'P**a' },
    shippingFee: '15000',
    cancelRequested: false,
    info: noOrderInfo,
    lines: lines.map((l, i) => ({
      externalLineId: `${id}-${i}`,
      variantId: l.variantId,
      sellerSku: l.variantId ? sku : 'SKU-KHAC',
      productName: 'Áo thun',
      unitPrice: '100000',
      sellerDiscount: '0',
      platformDiscount: '0',
      packageCode: l.pkg,
      trackingCode: null,
      rawStatus: String(l.status),
      status: l.status,
      info: noLineInfo,
      shipping: noShipping,
    })),
    ...o,
  } satisfies PlatformOrder;
}

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  ({ variantId, sku } = await createVariant(company.companyId));
  // Gian hàng thật để danh sách có tên gian hàng (channel qua `ctx.shopsOf`).
  const shop = await testPool().query(
    `insert into channel.shops (company_id, platform, external_shop_id, shop_name, status, order_cutoff_at) values ($1, 'lazada', $2, 'Shop Lazada', 'active', now()) returning id`,
    [company.companyId, `s-${randomUUID().slice(0, 8)}`],
  );
  shopId = shop.rows[0].id;
  const tag = randomUUID().slice(0, 6);
  const add = async (key: string, o: PlatformOrder) => {
    ids[key] = (await withCompany(company.companyId, () => ingestMarketplaceOrder(o))).orderId;
  };
  await add('twoPackages', order(`A-${tag}`, [
    { variantId, status: 'delivered', pkg: `FP-A1-${tag}` },
    { variantId, status: 'in_transit', pkg: `FP-A2-${tag}` },
  ]));
  await add('unmapped', order(`B-${tag}`, [{ variantId: null, status: 'pending', pkg: `FP-B-${tag}` }]));
  await add('unpaid', order(`C-${tag}`, [{ variantId, status: 'pending', pkg: `FP-C-${tag}` }], { paid: false }));
  await add('cancelRequested', order(`D-${tag}`, [{ variantId, status: 'packed', pkg: `FP-D-${tag}` }], { cancelRequested: true }));
});

const get = (path: string, token = company.ceo.token) => app().get(`/api/v1/sales${path}`).set('Authorization', `Bearer ${token}`);

describe('GET /sales/orders (#105)', () => {
  it('trả trang đơn đúng schema, mới trước, có tên gian hàng, giai đoạn suy từ kiện', async () => {
    const res = await get('/orders?pageSize=50');
    expect(res.status).toBe(200);
    const page = OrderSummaryPage.parse(res.body);
    expect(page.total).toBe(4);
    const byId = new Map(page.items.map((i) => [i.id, i]));
    expect(byId.get(ids.twoPackages!)).toMatchObject({
      source: 'marketplace',
      shop: { id: shopId, shopName: 'Shop Lazada', platform: 'lazada' },
      customer: null,
      status: 'processing',
      display: { stage: 'in_transit', delivered: 1, packages: 2 },
      total: 215000,
      lineCount: 2,
      paymentMethod: null,
    });
    expect(byId.get(ids.unmapped!)).toMatchObject({ display: { stage: 'unmapped' }, flags: ['unmapped_sku'] });
    expect(byId.get(ids.unpaid!)).toMatchObject({ status: 'unpaid', display: { stage: 'awaiting_payment' } });
    expect(byId.get(ids.cancelRequested!)!.flags).toEqual(['cancel_requested']);
  });

  it('lọc theo trạng thái, giai đoạn, cờ, tìm theo mã đơn sàn; phân trang', async () => {
    const ofQuery = async (q: string) => OrderSummaryPage.parse((await get(`/orders?${q}`)).body);
    expect((await ofQuery('status=unpaid')).items.map((i) => i.id)).toEqual([ids.unpaid]);
    expect((await ofQuery('stage=unmapped')).items.map((i) => i.id)).toEqual([ids.unmapped]);
    expect((await ofQuery('flag=cancel_requested')).items.map((i) => i.id)).toEqual([ids.cancelRequested]);
    expect((await ofQuery('flag=unmapped_sku')).items.map((i) => i.id)).toEqual([ids.unmapped]);
    expect((await ofQuery('stage=awaiting_payment')).items.map((i) => i.id)).toEqual([ids.unpaid]);
    expect((await ofQuery('stage=cancelled')).total).toBe(0);
    expect((await ofQuery('status=unpaid&stage=completed')).total).toBe(0);
    const code = (await ofQuery('pageSize=50')).items.find((i) => i.id === ids.twoPackages)!.code;
    expect((await ofQuery(`search=${code}`)).items.map((i) => i.id)).toEqual([ids.twoPackages]);
    const second = await ofQuery('page=2&pageSize=3');
    expect(second).toMatchObject({ total: 4, page: 2, pageSize: 3 });
    expect(second.items).toHaveLength(1);
  });

  it('cờ có yêu cầu trả: lọc theo yêu cầu trả còn mở, yêu cầu đã đóng không tính', async () => {
    const insert = (status: string, close: string | null) =>
      testPool().query(
        `insert into "order".return_requests (company_id, code, order_id, source, shop_id, external_return_id, status, close_result, reason)
         values ($1, $2, $3, 'marketplace', $4, $5, $6, $7, 'Khách đổi ý')`,
        [company.companyId, `TR-${randomUUID().slice(0, 8)}`, ids.twoPackages, shopId, randomUUID(), status, close],
      );
    await insert('closed', 'inspected');
    let page = OrderSummaryPage.parse((await get('/orders?flag=return_requested')).body);
    expect(page.total).toBe(0);
    await insert('requested', null);
    page = OrderSummaryPage.parse((await get('/orders?flag=return_requested')).body);
    expect(page.items.map((i) => [i.id, i.flags.includes('return_requested')])).toEqual([[ids.twoPackages, true]]);
  });

  it('lọc theo gian hàng (link từ hộp thoại ngắt, Documents/21 §18.6.1)', async () => {
    const ofShop = async (id: string) => OrderSummaryPage.parse((await get(`/orders?shopId=${id}&pageSize=50`)).body);
    expect((await ofShop(shopId)).total).toBe(4);
    expect((await ofShop(randomUUID())).total).toBe(0);
    const bad = await get('/orders?shopId=khong-phai-uuid');
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.body.errors)).toEqual(['shopId']);
  });

  it('tham số sai 422 theo ô', async () => {
    const res = await get('/orders?stage=khong_co&pageSize=500');
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.errors).sort()).toEqual(['pageSize', 'stage']);
  });
});

describe('GET /sales/orders/:id (#105)', () => {
  it('chi tiết đúng schema: dòng, kiện theo mã sàn, lịch sử, lý do chưa hoàn tất', async () => {
    const res = await get(`/orders/${ids.twoPackages}`);
    expect(res.status).toBe(200);
    const o = Order.parse(res.body);
    expect(o.lines).toHaveLength(2);
    expect(o.lines[0]).toMatchObject({ variantId, sku, unitPrice: 100000, lineTotal: 100000, externalSku: sku });
    expect(o.packages.map((p) => [p.status, p.platformPackageCode?.startsWith('FP-A')])).toEqual([
      ['delivered', true],
      ['in_transit', true],
    ]);
    expect(o.packages[0]).toMatchObject({ code: expect.stringMatching(/^KH-\d{6}$/), totalQty: 1, customerName: 'K***h' });
    expect(o.packages[0]!.deliveredAt).not.toBeNull();
    expect(o.completionBlocker).toBe('packages_open');
    expect(o.returnWindowEndsAt).not.toBeNull();
    expect(o.statusHistory.map((h) => [h.from, h.to, h.source])).toEqual([
      [null, 'unpaid', 'marketplace'],
      ['unpaid', 'processing', 'marketplace'],
    ]);
    expect(o).toMatchObject({ subtotal: 200000, shippingFee: 15000, invoiceNumber: null, shippingAddress: { name: 'K***h' } });
  });

  it('dòng chưa ghép: variantId null, sku lấy SKU sàn', async () => {
    const o = Order.parse((await get(`/orders/${ids.unmapped}`)).body);
    expect(o.lines[0]).toMatchObject({ variantId: null, sku: 'SKU-KHAC', externalSku: 'SKU-KHAC', attributesLabel: '' });
  });

  it('401 không token; 403 thiếu sales.order.view; 404 công ty khác và id sai dạng', async () => {
    expect((await app().get('/api/v1/sales/orders')).status).toBe(401);
    const warehouse = await addMember(company.companyId, 'warehouse');
    expect((await get('/orders', warehouse.token)).status).toBe(403);
    const other = await createCompany();
    expect((await get(`/orders/${ids.twoPackages}`, other.ceo.token)).status).toBe(404);
    expect((await get('/orders/khong-phai-uuid')).status).toBe(404);
    expect(OrderSummaryPage.parse((await get('/orders', other.ceo.token)).body).total).toBe(0);
  });
});

describe('thông tin đơn sàn ở danh sách và chi tiết (#260)', () => {
  let rich: Awaited<ReturnType<typeof createCompany>>;
  const richIds: Record<string, string> = {};

  beforeAll(async () => {
    rich = await createCompany({ optionalModules: ['channel'] });
    const v = await createVariant(rich.companyId);
    const shop = await testPool().query(
      `insert into channel.shops (company_id, platform, external_shop_id, shop_name, status, order_cutoff_at) values ($1, 'lazada', $2, 'Shop Lazada', 'active', now()) returning id`,
      [rich.companyId, `s-${randomUUID().slice(0, 8)}`],
    );
    const tag = randomUUID().slice(0, 6);
    const base = { ...order(`R-${tag}`, []), shopId: shop.rows[0].id };
    const line = (i: number, info: Partial<typeof noLineInfo>) => ({
      externalLineId: `R-${tag}-${i}`,
      variantId: v.variantId,
      sellerSku: v.sku,
      productName: `Áo ${i}`,
      unitPrice: '100000',
      sellerDiscount: '10000',
      platformDiscount: '0',
      packageCode: `FP-R-${tag}`,
      trackingCode: null,
      rawStatus: 'canceled',
      status: 'cancelled' as const,
      info: { ...noLineInfo, ...info },
      shipping: { ...noShipping, shipmentProvider: 'Drop-off: J&T VN, Delivery: J&T VN', shippingProviderType: 'standard' },
    });
    richIds.marketplace = (
      await withCompany(rich.companyId, () =>
        ingestMarketplaceOrder({
          ...base,
          shippingAddress: { name: 'N***n', phone: '84****11', address: 'P**a, Phường Bến Nghé', ward: 'Phường Bến Nghé', postCode: null, raw: { city: 'Phường Bến Nghé' } },
          info: { platformPaymentMethod: 'MIXEDCARD', buyerNote: 'Gọi trước', shippingFeeOriginal: '30000', shippingFeeDiscountSeller: '5000', shippingFeeDiscountPlatform: '10000' },
          lines: [
            line(0, {
              thumbnailUrl: 'https://img/0.jpg',
              attributesLabel: 'Màu: Đỏ',
              externalSkuId: '1175',
              externalShopSku: '1175_VNAMZ',
              externalProductId: '900',
              paidPrice: '90000',
              taxAmount: '0',
              cancelReason: 'Đổi ý',
              cancelReasonDetail: 'Khách đặt nhầm',
              cancelInitiator: 'buyer',
              cancelKind: 'cancellation',
            }),
            { ...line(1, { cancelKind: 'failed_delivery' }), unitPrice: '50000' },
          ],
        }),
      )
    ).orderId;
    richIds.manual = (await createOrder(rich.companyId, { lines: [{ variantId: v.variantId, quantity: 3, unitPrice: 20000 }] })).orderId;
  });

  const getRich = (path: string) => get(path, rich.ceo.token);

  it('danh sách: mã đơn sàn, người nhận, phương thức trên sàn, dòng đầu, tổng số lượng; đơn tay để null', async () => {
    const page = OrderSummaryPage.parse((await getRich('/orders?pageSize=50')).body);
    const byId = new Map(page.items.map((i) => [i.id, i]));
    expect(byId.get(richIds.marketplace!)).toMatchObject({
      externalOrderId: expect.stringMatching(/^R-/),
      recipientName: 'N***n',
      paymentMethod: null,
      platformPaymentMethod: 'MIXEDCARD',
      totalQty: 2,
      itemsPreview: { productName: 'Áo 0', attributesLabel: 'Màu: Đỏ', thumbnailUrl: 'https://img/0.jpg', quantity: 1 },
    });
    expect(byId.get(richIds.manual!)).toMatchObject({
      externalOrderId: null,
      recipientName: null,
      platformPaymentMethod: null,
      paymentMethod: 'prepaid',
      totalQty: 3,
      itemsPreview: { attributesLabel: '', thumbnailUrl: null, quantity: 3 },
    });
  });

  it('chi tiết: địa chỉ có phường, phí ship gốc và giảm, ghi chú khách, thông tin dòng, vận chuyển kiện', async () => {
    const o = Order.parse((await getRich(`/orders/${richIds.marketplace}`)).body);
    expect(o).toMatchObject({
      buyerNote: 'Gọi trước',
      shippingFeeOriginal: 30000,
      shippingFeeDiscountSeller: 5000,
      shippingFeeDiscountPlatform: 10000,
      shippingAddress: { name: 'N***n', ward: 'Phường Bến Nghé', postCode: null },
    });
    expect(o.shippingAddress).not.toHaveProperty('raw');
    expect(o.lines[0]).toMatchObject({
      attributesLabel: 'Màu: Đỏ',
      thumbnailUrl: 'https://img/0.jpg',
      externalSkuId: '1175',
      externalShopSku: '1175_VNAMZ',
      externalProductId: '900',
      paidPrice: 90000,
      taxAmount: 0,
      cancelReason: 'Đổi ý',
      cancelReasonDetail: 'Khách đặt nhầm',
      cancelInitiator: 'buyer',
      cancelKind: 'cancellation',
      reverseOrderId: null,
      returnStatus: null,
    });
    expect(o.lines[1]).toMatchObject({ attributesLabel: '', paidPrice: null, cancelInitiator: null, cancelKind: 'failed_delivery' });
    expect(o.packages[0]).toMatchObject({
      shipmentProvider: 'Drop-off: J&T VN, Delivery: J&T VN',
      shippingProviderType: 'standard',
      promisedShippingAt: null,
    });
    expect(o.packages[0]!.lines[0]).toMatchObject({ attributesLabel: 'Màu: Đỏ' });
  });

  it('đơn tạo tay: các trường sàn null', async () => {
    const o = Order.parse((await getRich(`/orders/${richIds.manual}`)).body);
    expect(o).toMatchObject({ buyerNote: null, shippingFeeOriginal: null, shippingAddress: null });
    expect(o.lines[0]).toMatchObject({ thumbnailUrl: null, externalSkuId: null, paidPrice: null, cancelKind: null, attributesLabel: '' });
  });
});
