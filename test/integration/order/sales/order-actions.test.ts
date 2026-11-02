import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketplaceError } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { Order } from '#src/modules/order/sales/api/schemas.ts';
import { ingestMarketplaceOrder, type PlatformOrder } from '#src/modules/order/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { createOrder } from '../../helpers/sales.ts';
import { fakeAdapter } from '../../channel/channel/helpers.ts';

// Sàn giả: lý do huỷ, huỷ, quyết định yêu cầu huỷ. `refuse` bật thì sàn từ chối huỷ.
let refuse = false;
const cancelReasons = vi.fn(async () => {
  if (refuse) throw new MarketplaceError('rejected', 'not_cancellable', 'Đơn có khuyến mãi gói, không huỷ được');
  return [
    { id: '10000007', label: 'Hết hàng' },
    { id: '10000009', label: 'Sai giá' },
  ];
});
const cancelOrder = vi.fn(async () => {});
const decideCancelRequest = vi.fn(async () => {});
registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
    },
    cancelReasons,
    cancelOrder,
    decideCancelRequest,
  }),
);
afterAll(() => resetAdapters());

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
let shopId: string;
let variantId: string;
let sku: string;
const auth = (r: request.Test, token = company.ceo.token) => r.set('Authorization', `Bearer ${token}`);

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  const res = await auth(app().post('/api/v1/channel/shops/lazada/token')).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  shopId = res.body.shop.id;
  await testPool().query(`update channel.shops set status = 'active', order_cutoff_at = now() where id = $1`, [shopId]);
  ({ variantId, sku } = await createVariant(company.companyId));
});

beforeEach(() => {
  refuse = false;
  cancelReasons.mockClear();
  cancelOrder.mockClear();
  decideCancelRequest.mockClear();
});

function remote(status: PlatformOrder['lines'][number]['status'], o: Partial<PlatformOrder> = {}): PlatformOrder {
  const id = `LZ-${randomUUID().slice(0, 8)}`;
  return {
    shopId,
    externalOrderId: id,
    rawStatus: String(status),
    paid: true,
    isCod: true,
    placedAt: new Date(),
    shipBy: null,
    shippingAddress: null,
    shippingFee: '0',
    cancelRequested: false,
    lines: [
      {
        externalLineId: `${id}-1`,
        variantId,
        sellerSku: sku,
        productName: 'Áo',
        unitPrice: '100000',
        sellerDiscount: '0',
        platformDiscount: '0',
        packageCode: `FP-${id}`,
        trackingCode: null,
        rawStatus: String(status),
        status,
      },
    ],
    ...o,
  };
}
const ingest = (o: PlatformOrder) => withCompany(company.companyId, () => ingestMarketplaceOrder(o));
const detail = async (id: string) => Order.parse((await auth(app().get(`/api/v1/sales/orders/${id}`))).body);
const post = (path: string, body?: object, token?: string) => auth(app().post(`/api/v1/sales/orders/${path}`), token).send(body);

describe('lý do huỷ (§19.3)', () => {
  it('trả lý do sàn cho phép, gửi đủ mã món', async () => {
    const o = remote('pending');
    const { orderId } = await ingest(o);
    const res = await auth(app().get(`/api/v1/sales/orders/${orderId}/cancel-reasons`));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [{ id: '10000007', label: 'Hết hàng' }, { id: '10000009', label: 'Sai giá' }] });
    expect(cancelReasons).toHaveBeenCalledWith(expect.any(String), o.externalOrderId, [o.lines[0]!.externalLineId]);
  });

  it('sàn không cho huỷ: 409 marketplace_rejected kèm câu của sàn', async () => {
    const { orderId } = await ingest(remote('pending'));
    refuse = true;
    const res = await auth(app().get(`/api/v1/sales/orders/${orderId}/cancel-reasons`));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'marketplace_rejected', platformMessage: 'Đơn có khuyến mãi gói, không huỷ được' });
  });

  it('đơn tạo tay: 422 not_allowed_for_source; Nhân viên kho: 403', async () => {
    const manual = await createOrder(company.companyId, { lines: [{ variantId, quantity: 1, unitPrice: 100000 }], source: 'manual' });
    const res = await auth(app().get(`/api/v1/sales/orders/${manual.orderId}/cancel-reasons`));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('not_allowed_for_source');
    const warehouse = await addMember(company.companyId, 'warehouse');
    const { orderId } = await ingest(remote('pending'));
    expect((await auth(app().get(`/api/v1/sales/orders/${orderId}/cancel-reasons`), warehouse.token)).status).toBe(403);
  });
});

describe('huỷ đơn sàn (§19.3, phương án a)', () => {
  it('gửi lý do lên sàn, đơn giữ trạng thái, cờ Đang huỷ; sàn xác nhận ở lần kéo sau thì cancelled', async () => {
    const o = remote('packed');
    const { orderId } = await ingest(o);
    const before = await detail(orderId);
    const res = await post(`${orderId}/platform-cancel`, { version: before.version, reasonId: '10000007' });
    expect(res.status).toBe(200);
    expect(res.body.pendingOpen).toBe(1);
    const order = Order.parse(res.body.order);
    expect(order).toMatchObject({ status: 'processing', cancelReason: 'Hết hàng' });
    expect(order.flags).toContain('cancelling');
    expect(cancelOrder).toHaveBeenCalledWith(expect.any(String), o.externalOrderId, [o.lines[0]!.externalLineId], '10000007');

    const audit = await testPool().query(
      `select action, actor_id is not null as by_user, after->>'reasonId' as reason from core.audit_logs where entity_type = 'order.orders' and entity_id = $1`,
      [orderId],
    );
    expect(audit.rows).toEqual([{ action: 'update', by_user: true, reason: '10000007' }]);

    // Đang huỷ thì không gửi lần nữa.
    const again = await post(`${orderId}/platform-cancel`, { version: order.version, reasonId: '10000007' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('invalid_transition');

    const confirmed = structuredClone(o);
    confirmed.lines[0]!.status = 'cancelled';
    await ingest(confirmed);
    const after = await detail(orderId);
    expect(after.packages[0]!.flags).toContain('needs_open');
  });

  it('lý do không có trong danh sách sàn: 422 errors.reasonId, không gọi huỷ', async () => {
    const { orderId } = await ingest(remote('pending'));
    const res = await post(`${orderId}/platform-cancel`, { version: (await detail(orderId)).version, reasonId: 'khong-co' });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.errors)).toEqual(['reasonId']);
    expect(cancelOrder).not.toHaveBeenCalled();
  });

  it('version cũ: 409 version_conflict kèm current, không gọi sàn', async () => {
    const { orderId } = await ingest(remote('pending'));
    const res = await post(`${orderId}/platform-cancel`, { version: 999, reasonId: '10000007' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('version_conflict');
    expect(Order.parse(res.body.current).id).toBe(orderId);
    expect(cancelReasons).not.toHaveBeenCalled();
  });

  it('kiện đã rời kho: 409 already_handed_over', async () => {
    const { orderId } = await ingest(remote('in_transit'));
    const res = await post(`${orderId}/platform-cancel`, { version: (await detail(orderId)).version, reasonId: '10000007' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('already_handed_over');
  });

  it('sàn từ chối lúc huỷ: 409 marketplace_rejected, đơn không đổi', async () => {
    const { orderId } = await ingest(remote('pending'));
    const before = await detail(orderId);
    cancelOrder.mockRejectedValueOnce(new MarketplaceError('rejected', 'cancel_refused', 'Không huỷ được'));
    const res = await post(`${orderId}/platform-cancel`, { version: before.version, reasonId: '10000007' });
    expect(res.status).toBe(409);
    const after = await detail(orderId);
    expect(after.version).toBe(before.version);
    expect(after.flags).not.toContain('cancelling');
  });
});

describe('khách xin huỷ (§19.3)', () => {
  it('không có cờ khách xin huỷ: 409 invalid_transition', async () => {
    const { orderId } = await ingest(remote('pending'));
    const res = await post(`${orderId}/cancel-request`, { version: (await detail(orderId)).version, decision: 'accept' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('invalid_transition');
  });

  it('đồng ý: báo sàn, bỏ cờ xin huỷ, sang Đang huỷ chờ sàn xác nhận', async () => {
    const o = remote('pending', { cancelRequested: true });
    const { orderId } = await ingest(o);
    const res = await post(`${orderId}/cancel-request`, { version: (await detail(orderId)).version, decision: 'accept' });
    expect(res.status).toBe(200);
    const order = Order.parse(res.body);
    expect(order.flags).toEqual(expect.arrayContaining(['cancelling']));
    expect(order.flags).not.toContain('cancel_requested');
    expect(decideCancelRequest).toHaveBeenCalledWith(expect.any(String), o.externalOrderId, true);
  });

  it('từ chối: báo sàn, bỏ cờ, đơn chạy tiếp', async () => {
    const { orderId } = await ingest(remote('pending', { cancelRequested: true }));
    const res = await post(`${orderId}/cancel-request`, { version: (await detail(orderId)).version, decision: 'reject' });
    expect(res.status).toBe(200);
    expect(Order.parse(res.body).flags).toEqual([]);
    expect(decideCancelRequest).toHaveBeenCalledWith(expect.any(String), expect.any(String), false);
  });
});

describe('số hoá đơn (§19.3)', () => {
  it('lưu, đọc lại thấy; version cũ 409; quá 50 ký tự 422', async () => {
    const { orderId } = await ingest(remote('delivered'));
    const v = (await detail(orderId)).version;
    const put = (body: object) => auth(app().put(`/api/v1/sales/orders/${orderId}/invoice-number`)).send(body);
    const res = await put({ version: v, invoiceNumber: ' HD-0001 ' });
    expect(res.status).toBe(200);
    expect(Order.parse(res.body).invoiceNumber).toBe('HD-0001');
    expect((await detail(orderId)).invoiceNumber).toBe('HD-0001');
    expect((await put({ version: v, invoiceNumber: 'HD-0002' })).body.code).toBe('version_conflict');
    const long = await put({ version: v + 1, invoiceNumber: 'x'.repeat(51) });
    expect(long.status).toBe(422);
    expect(Object.keys(long.body.errors)).toEqual(['invoiceNumber']);
  });
});
