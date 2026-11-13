import { randomUUID } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { MarketplacePackages } from '#src/modules/order/fulfillment/service/packages.ts';
import { currentCompanyId } from '#src/shared/db/client.ts';
import { AppError } from '#src/shared/errors/app-error.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { channelShop, packingApp, seedPackage } from './helpers.ts';

let companyId: string;
let warehouse: string;
let sale: string;
let variantId: string;
let shop1: string;
let shop2: string;
let ids: string[];

beforeAll(async () => {
  ({ companyId } = await createCompany());
  warehouse = (await addMember(companyId, 'warehouse')).token;
  sale = (await addMember(companyId, 'sale')).token;
  variantId = (await createVariant(companyId)).variantId;
  [shop1, shop2] = await Promise.all([channelShop(companyId, false), channelShop(companyId, false)]);
  ids = (await Promise.all([seed(shop1, 'FP1'), seed(shop1, 'FP1'), seed(shop2, 'FP2')])).map((pkg) => pkg.packageId);
});

const seed = (shopId: string, platformPackageCode: string | null) =>
  seedPackage(companyId, { status: 'awaiting_pickup', shopId, platformPackageCode, lines: [{ variantId, quantity: 1 }] });

const get = (selected: readonly string[], fake: Partial<MarketplacePackages> = {}, token = warehouse, kind = 'awb') =>
  packingApp(fake).get('/api/v1/fulfillment/packages/documents')
    .query({ ids: selected.join(','), kind }).set('Authorization', `Bearer ${token}`);

async function pdf(width: number) {
  const doc = await PDFDocument.create();
  doc.addPage([width, 200]).drawText('Van don');
  return doc.save();
}

describe('in vận đơn PDF', () => {
  it('US-DH-07 AC2: gộp theo thứ tự gian hàng, mỗi mã nhóm gọi một lần', async () => {
    const shippingDocuments = vi.fn(async (_companyId: string, shopId: string) => {
      expect(currentCompanyId()).toBeNull();
      return [await pdf(shopId === shop1 ? 100 : 150)];
    });
    const res = await get([ids[2]!, ids[0]!, ids[1]!], { shippingDocuments }).buffer(true).parse((response, callback) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => callback(null, Buffer.concat(chunks)));
      response.on('error', callback);
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="van-don-\d{8}-\d{4}\.pdf"$/);
    expect((await PDFDocument.load(res.body)).getPages().map((page) => page.getWidth())).toEqual([150, 100]);
    expect(shippingDocuments.mock.calls).toEqual([[companyId, shop2, ['FP2']], [companyId, shop1, ['FP1']]]);
  });

  it('US-DH-07 AC3: liệt kê đúng các kiện thiếu mã trước khi gọi sàn', async () => {
    const missing = await seed(shop1, null);
    const manual = await seedPackage(companyId, { status: 'awaiting_pickup', manual: true, lines: [{ variantId, quantity: 1 }] });
    const res = await get([ids[0]!, ids[1]!, missing.packageId, manual.packageId]);
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/document_not_ready');
    expect(res.body.detail).toContain(missing.packageCode);
    expect(res.body.detail).toContain(manual.packageCode);
    expect(res.body.detail.match(/KH-/g)).toHaveLength(2);
  });

  it('kiện thuộc công ty khác trả 404', async () => {
    const other = await createCompany();
    const variant = await createVariant(other.companyId);
    const { packageId } = await seedPackage(other.companyId, { status: 'packed', lines: [{ variantId: variant.variantId, quantity: 1 }] });
    const res = await get([ids[0]!, packageId]);
    expect(res.status).toBe(404);
    expect(res.body.type).toBe('/problems/not_found');
  });

  it.each([
    [[], 'awb', 'ids'], [Array.from({ length: 51 }, () => randomUUID()), 'awb', 'ids'], [[randomUUID()], 'khac', 'kind'],
  ] as const)('đầu vào sai trả lỗi theo trường', async (selected, kind, field) => {
    const res = await get(selected, {}, warehouse, kind);
    expect(res.status).toBe(422);
    expect(res.body.type).toBe('/problems/validation_failed');
    expect(res.body.errors[field]).toBeDefined();
  });

  it('TikTok chưa giao kiện trả Problem Details', async () => {
    const shippingDocuments = async () => { throw new AppError(409, 'document_not_ready', 'Sàn chưa tạo vận đơn', { platformCode: '21042104' }); };
    const res = await get([ids[0]!], { shippingDocuments });
    expect(res.status).toBe(409);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ type: '/problems/document_not_ready', platformCode: '21042104' });
  });

  it.each(['<html>lỗi</html>', '%PDF-1.4\nKhông có trang'])('PDF hỏng trả 503 và không gửi tệp', async (data) => {
    const res = await get([ids[0]!], { shippingDocuments: async () => [Buffer.from(data)] });
    expect(res.status).toBe(503);
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.body.type).toBe('/problems/marketplace_unavailable');
  });

  it('vượt 50 MB trả 422 tại ids', async () => {
    const large = new Uint8Array(10 * 1024 * 1024);
    const res = await get([ids[0]!], { shippingDocuments: async () => Array.from({ length: 6 }, () => large) });
    expect(res.status).toBe(422);
    expect(res.body.type).toBe('/problems/validation_failed');
    expect(res.body.errors.ids).toBeDefined();
  });

  it('Sale không có quyền in vận đơn', async () => {
    const res = await get([ids[0]!], {}, sale);
    expect(res.status).toBe(403);
    expect(res.body.type).toBe('/problems/forbidden');
  });
});
