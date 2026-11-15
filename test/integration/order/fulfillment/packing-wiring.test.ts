// Đóng gói, báo sẵn sàng, mở kiện, in vận đơn đi trọn đường thật (#239): route fulfillment → `ctx.marketplacePackages` dựng
// ở src/wiring.ts → cổng `order-actions.ts` của channel → `shopSession` (giải mã token gian hàng) → adapter. Adapter là
// adapter giả đăng ký cho `lazada`; cách Lazada dựng request, đọc phản hồi có ở unit test `lazada-packing.test.ts`.
import { randomUUID } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketplaceError, type MarketplaceAdapter } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { fakeAdapter } from '../../channel/channel/helpers.ts';
import { packageRow, seedPackage } from './helpers.ts';

const sàn = {
  shipmentProviders: vi.fn<NonNullable<MarketplaceAdapter['shipmentProviders']>>(),
  packItems: vi.fn<NonNullable<MarketplaceAdapter['packItems']>>(),
  readyToShip: vi.fn<NonNullable<MarketplaceAdapter['readyToShip']>>(),
  repackPackage: vi.fn<NonNullable<MarketplaceAdapter['repackPackage']>>(),
  shippingDocuments: vi.fn<NonNullable<MarketplaceAdapter['shippingDocuments']>>(),
};
registerAdapter(
  'lazada',
  fakeAdapter({
    getSeller: async (accessToken) => ({ externalShopId: accessToken.slice(4, 16), shopName: 'Shop thử', region: 'VN' }),
    shipmentProviders: (...args) => sàn.shipmentProviders(...args),
    packItems: (...args) => sàn.packItems(...args),
    readyToShip: (...args) => sàn.readyToShip(...args),
    repackPackage: (...args) => sàn.repackPackage(...args),
    shippingDocuments: (...args) => sàn.shippingDocuments(...args),
  }),
);
afterAll(() => resetAdapters());
beforeEach(() => {
  for (const fn of Object.values(sàn)) fn.mockReset();
});

let companyId: string;
let warehouse: string;
let variantId: string;
let shopId: string;
let accessToken: string;
beforeAll(async () => {
  const company = await createCompany({ optionalModules: ['channel'] });
  companyId = company.companyId;
  warehouse = (await addMember(companyId, 'warehouse')).token;
  variantId = (await createVariant(companyId)).variantId;
  await receive(companyId, variantId, 100, 100_000);
  accessToken = `tok-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const res = await request(testApp())
    .post('/api/v1/channel/shops/lazada/token')
    .set('Authorization', `Bearer ${company.ceo.token}`)
    .send({ accessToken });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  shopId = res.body.shop.id;
});

const api = () => request(testApp());
const auth = (req: request.Test) => req.set('Authorization', `Bearer ${warehouse}`);
const seed = (status: 'reserved' | 'packed' | 'awaiting_pickup', platformPackageCode: string | null = null) =>
  seedPackage(companyId, { status, shopId, platformPackageCode, lines: [{ variantId, quantity: 1, reserved: true }] });
const externalOf = async (orderId: string) => {
  const { rows } = await testPool().query<{ order_ext: string; line_ext: string }>(
    `select o.external_order_id as order_ext, l.external_line_id as line_ext
     from "order".orders o join "order".order_lines l on l.order_id = o.id where o.id = $1`,
    [orderId],
  );
  return { externalOrderId: rows[0]!.order_ext, externalLineIds: rows.map((r) => r.line_ext) };
};
async function onePagePdf() {
  const doc = await PDFDocument.create();
  doc.addPage([298, 420]);
  return doc.save();
}

describe('đóng gói, báo sẵn sàng, in vận đơn qua cổng thật của channel', () => {
  it('đóng gói gọi adapter với token đã giải mã, mã đơn, mã món sàn; nhà vận chuyển NTFS đi cùng', async () => {
    const { packageId, orderId } = await seed('reserved');
    sàn.shipmentProviders.mockResolvedValue({ platformChooses: false, items: [{ code: 'LEX', name: 'LEX VN', isDefault: true }] });
    sàn.packItems.mockResolvedValue({ packageCode: 'FP-WIRE-1', trackingCode: 'LZ-WIRE-1', carrier: { code: 'LEX', name: 'LEX VN' } });

    const carriers = await auth(api().get(`/api/v1/fulfillment/packages/${packageId}/carriers`));
    expect(carriers.status, JSON.stringify(carriers.body)).toBe(200);
    expect(carriers.body).toEqual({ items: [{ code: 'LEX', name: 'LEX VN', isDefault: true }] });

    const res = await auth(api().post(`/api/v1/fulfillment/packages/${packageId}/pack`))
      .send({ version: 1, lines: [{ variantId, quantity: 1 }], carrierCode: 'LEX' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: 'packed', platformPackageCode: 'FP-WIRE-1', trackingCode: 'LZ-WIRE-1', carrier: { code: 'LEX' } });
    expect(sàn.packItems).toHaveBeenCalledWith(accessToken, { ...(await externalOf(orderId)), carrierCode: 'LEX' });
  });

  it('lỗi sàn 700026 khi đóng gói thành 409 item_not_packable kèm mã gốc, kiện giữ nguyên', async () => {
    const { packageId } = await seed('reserved');
    sàn.packItems.mockRejectedValue(new MarketplaceError('rejected', '700026', 'Item is canceled'));
    const res = await auth(api().post(`/api/v1/fulfillment/packages/${packageId}/pack`)).send({ version: 1, lines: [{ variantId, quantity: 1 }] });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ type: '/problems/item_not_packable', platformCode: '700026', platformMessage: 'Item is canceled' });
    expect(await packageRow(packageId)).toMatchObject({ status: 'reserved', version: 1 });
  });

  it('báo sẵn sàng gửi đúng mã kiện sàn; sàn lỗi 30012 thì 409 rts_package_not_found và bật cờ', async () => {
    const ok = await seed('packed', 'FP-WIRE-RTS');
    sàn.readyToShip.mockResolvedValue();
    const res = await auth(api().post(`/api/v1/fulfillment/packages/${ok.packageId}/ready`)).send({ version: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('awaiting_pickup');
    expect(sàn.readyToShip).toHaveBeenCalledWith(accessToken, ['FP-WIRE-RTS']);

    const bad = await seed('packed', 'FP-WIRE-RTS-2');
    sàn.readyToShip.mockRejectedValue(new MarketplaceError('rejected', '30012', 'rts package not found'));
    const failed = await auth(api().post(`/api/v1/fulfillment/packages/${bad.packageId}/ready`)).send({ version: 1 });
    expect(failed.status).toBe(409);
    expect(failed.body.type).toBe('/problems/rts_package_not_found');
    expect(await packageRow(bad.packageId)).toMatchObject({ status: 'packed', label_error: true });
  });

  it('mở kiện gọi repack rồi xoá mã kiện sàn', async () => {
    const { packageId } = await seed('packed', 'FP-WIRE-OPEN');
    sàn.repackPackage.mockResolvedValue();
    const res = await auth(api().post(`/api/v1/fulfillment/packages/${packageId}/open`)).send({ version: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: 'reserved', platformPackageCode: null });
    expect(sàn.repackPackage).toHaveBeenCalledWith(accessToken, 'FP-WIRE-OPEN');
  });

  it('in vận đơn trả một PDF gộp từ tệp adapter trả', async () => {
    const a = await seed('awaiting_pickup', 'FP-WIRE-DOC-1');
    const b = await seed('awaiting_pickup', 'FP-WIRE-DOC-2');
    sàn.shippingDocuments.mockResolvedValue([await onePagePdf(), await onePagePdf()]);
    const res = await auth(api().get('/api/v1/fulfillment/packages/documents').query({ ids: `${a.packageId},${b.packageId}` }))
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(sàn.shippingDocuments).toHaveBeenCalledWith(accessToken, ['FP-WIRE-DOC-1', 'FP-WIRE-DOC-2']);
    expect((await PDFDocument.load(res.body as Buffer)).getPageCount()).toBe(2);
  });
});
