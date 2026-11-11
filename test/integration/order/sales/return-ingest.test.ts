// Yêu cầu trả từ sàn (#202, Documents/25 §9, Documents/21 §20.1): kéo về qua adapter giả, đi theo máy trạng thái, kiểm
// hàng hoàn xong thì đóng.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { markProcessed } from '#src/modules/core/platform/repository/outbox.ts';
import { HandlerFailure, type IncomingMessage, processMessage } from '#src/modules/core/platform/service/outbox/consumer.ts';
import type { RemoteReturn } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { pullShopReturns } from '#src/modules/channel/channel/service/return-pull.ts';
import { ingestMarketplaceOrder, type PlatformOrder } from '#src/modules/order/index.ts';
import { onReturnInspected } from '#src/modules/order/sales/service/return-ingest.ts';
import { type ReturnStockPort, setReturnStockPort } from '#src/modules/order/sales/service/return-stock-port.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { fakeAdapter } from '../../channel/channel/helpers.ts';
import { noLineInfo, noOrderInfo, noShipping } from './helpers.ts';

let remote: RemoteReturn[] = [];
const seenSince: Date[] = [];
registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
    },
    async listReturns(_token, updatedAfter, cursor) {
      seenSince.push(updatedAfter);
      // Hai trang: kiểm cả lật con trỏ.
      const half = Math.ceil(remote.length / 2);
      return cursor === null ? { items: remote.slice(0, half), nextCursor: '2' } : { items: remote.slice(half), nextCursor: null };
    },
  }),
);
afterAll(() => resetAdapters());

let company: Awaited<ReturnType<typeof createCompany>>;
let shopId: string;
let variantId: string;
let sku: string;
const db = () => testPool();

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  const res = await request(testApp())
    .post('/api/v1/channel/shops/lazada/token')
    .set('Authorization', `Bearer ${company.ceo.token}`)
    .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  shopId = res.body.shop.id;
  await db().query(`update channel.shops set status = 'active', order_cutoff_at = now() - interval '1 day' where id = $1`, [shopId]);
  ({ variantId, sku } = await createVariant(company.companyId));
});

/** Đơn sàn hai món một kiện, kiện ở `status`. */
async function marketplaceOrder(status: 'delivered' | 'in_transit' = 'delivered') {
  const id = `LZ-${randomUUID().slice(0, 8)}`;
  const order: PlatformOrder = {
    shopId,
    externalOrderId: id,
    rawStatus: status,
    paid: true,
    isCod: false,
    placedAt: new Date(),
    shipBy: null,
    shippingAddress: null,
    shippingFee: '0',
    cancelRequested: false,
    info: noOrderInfo,
    lines: [1, 2].map((n) => ({
      externalLineId: `${id}-${n}`,
      variantId,
      sellerSku: sku,
      productName: 'Áo',
      unitPrice: '32000',
      sellerDiscount: '0',
      platformDiscount: '0',
      packageCode: `FP-${id}`,
      trackingCode: null,
      rawStatus: status,
      status,
      info: noLineInfo,
      shipping: noShipping,
    })),
  };
  const { orderId } = await withCompany(company.companyId, () => ingestMarketplaceOrder(order));
  return { externalOrderId: id, orderId };
}

function remoteReturn(externalOrderId: string, patch: Partial<RemoteReturn> = {}): RemoteReturn {
  const externalId = patch.externalId ?? `RV-${randomUUID().slice(0, 8)}`;
  return {
    externalId,
    externalOrderId,
    rawStatus: 'REQUEST_INITIATE',
    ofcStatus: null,
    initiator: 'buyer',
    reasonCode: '120000003',
    reason: 'Hàng lỗi',
    refundAmount: '64000',
    lines: [1, 2].map((n) => ({ externalLineId: `${externalOrderId}-${n}`, externalReturnLineId: `${externalId}-L${n}`, externalSkuId: null, sellerSku: sku, refundAmount: '32000', quantity: 1 })),
    createdAt: new Date(),
    updatedAt: new Date(),
    kind: 'return',
    status: 'requested',
    closeResult: null,
    disputeInProgress: false,
    returnTrackingCode: null,
    respondBy: null,
    returnTo: 'merchant',
    ...patch,
  };
}

const requestOf = async (externalId: string) =>
  (await db().query(`select * from "order".return_requests where shop_id = $1 and external_return_id = $2`, [shopId, externalId])).rows[0];
const historyOf = async (id: string) =>
  (await db().query(`select action, source, to_state as to_status from core.state_transitions where entity_type = 'return_requests' and entity_id = $1 order by id`, [id])).rows;

describe('kéo yêu cầu trả từ sàn', () => {
  it('tạo yêu cầu cho đơn đã có, gắn dòng đơn, kiện, mã dòng sàn; đơn chưa có thì bỏ; tiến mốc kéo', async () => {
    const { externalOrderId, orderId } = await marketplaceOrder();
    const r = remoteReturn(externalOrderId);
    remote = [r, remoteReturn('LZ-khong-co')];
    const result = await pullShopReturns(company.companyId, shopId);
    expect(result).toMatchObject({ created: 1, unknown_order: 1 });

    const row = await requestOf(r.externalId);
    expect(row).toMatchObject({ order_id: orderId, source: 'marketplace', status: 'requested', reason: 'Hàng lỗi', raw_marketplace_status: 'REQUEST_INITIATE', return_to: 'merchant', needs_attention: false });
    expect(row.code).toMatch(/^YCT-\d{6}$/);
    expect(Number(row.refund_amount)).toBe(64000);
    const lines = await db().query(`select quantity, unit_price, external_line_id, package_id, variant_id from "order".return_request_lines where request_id = $1 order by external_line_id`, [row.id]);
    expect(lines.rows.map((l) => [l.quantity, Number(l.unit_price), l.external_line_id, l.package_id !== null, l.variant_id])).toEqual([
      [1, 32000, `${r.externalId}-L1`, true, variantId],
      [1, 32000, `${r.externalId}-L2`, true, variantId],
    ]);
    const shop = await db().query(`select last_return_sync_at from channel.shops where id = $1`, [shopId]);
    expect(shop.rows[0].last_return_sync_at).not.toBeNull();

    // Lượt sau kéo từ mốc mới (lùi 2 phút), cùng yêu cầu không tạo lần hai.
    seenSince.length = 0;
    expect(await pullShopReturns(company.companyId, shopId)).toMatchObject({ created: 0 });
    expect(seenSince[0]!.getTime()).toBe(shop.rows[0].last_return_sync_at.getTime() - 2 * 60_000);
  });

  it('kéo lại yêu cầu không đổi gì thì không ghi, không tăng version (review #202 mục 9)', async () => {
    const { externalOrderId } = await marketplaceOrder();
    const r = remoteReturn(externalOrderId);
    remote = [r];
    await pullShopReturns(company.companyId, shopId);
    const before = await requestOf(r.externalId);
    expect(await pullShopReturns(company.companyId, shopId)).toMatchObject({ unchanged: 1 });
    const after = await requestOf(r.externalId);
    expect([after.version, after.updated_at]).toEqual([before.version, before.updated_at]);
  });

  it('sàn đồng ý trả: requested → awaiting_return qua `accept` nguồn sàn; bản cũ hơn bị bỏ', async () => {
    const { externalOrderId } = await marketplaceOrder();
    const r = remoteReturn(externalOrderId);
    remote = [r];
    await pullShopReturns(company.companyId, shopId);
    remote = [{ ...r, rawStatus: 'REFUND_PENDING', status: 'awaiting_return', returnTrackingCode: 'JNT-VE-1', updatedAt: new Date(Date.now() + 1000) }];
    await pullShopReturns(company.companyId, shopId);
    const row = await requestOf(r.externalId);
    expect(row).toMatchObject({ status: 'awaiting_return', return_tracking_code: 'JNT-VE-1', raw_marketplace_status: 'REFUND_PENDING' });
    expect(await historyOf(row.id)).toEqual([{ action: 'accept', source: 'marketplace', to_status: 'awaiting_return' }]);

    remote = [{ ...r, rawStatus: 'REQUEST_INITIATE', status: 'requested', updatedAt: new Date(Date.now() - 60_000) }];
    expect(await pullShopReturns(company.companyId, shopId)).toMatchObject({ unchanged: 1 });
    expect((await requestOf(r.externalId)).status).toBe('awaiting_return');
  });

  it('lần đầu thấy đã hoàn tiền không cần trả hàng: đi tới refund_only, phát `sales.return_refunded`', async () => {
    const { externalOrderId } = await marketplaceOrder();
    const r = remoteReturn(externalOrderId, { rawStatus: 'REFUND_SUCCESS', ofcStatus: 'RETURN_CANCELED', status: 'refund_only' });
    remote = [r];
    await pullShopReturns(company.companyId, shopId);
    const row = await requestOf(r.externalId);
    expect(row).toMatchObject({ status: 'refund_only', refunded: true, ofc_status: 'RETURN_CANCELED' });
    expect((await historyOf(row.id)).map((h) => h.action)).toEqual(['refund_only']);
    const event = await db().query(`select payload from core.outbox_messages where type = 'sales.return_refunded' and payload->>'returnRequestId' = $1`, [row.id]);
    expect(Number(event.rows[0].payload.refundAmount)).toBe(64000);
  });

  it('lần đầu thấy hàng đã về người bán: sang awaiting_return qua `accept` của sàn, chờ kho quét', async () => {
    const { externalOrderId } = await marketplaceOrder();
    const r = remoteReturn(externalOrderId, { rawStatus: 'REFUND_PENDING', ofcStatus: 'INFO_ST_RETURN_RTM_DELIVERED', status: 'received' });
    remote = [r];
    await pullShopReturns(company.companyId, shopId);
    const row = await requestOf(r.externalId);
    expect(row).toMatchObject({ status: 'awaiting_return', needs_attention: false });
    expect(await historyOf(row.id)).toEqual([{ action: 'accept', source: 'marketplace', to_status: 'awaiting_return' }]);
  });

  it('yêu cầu chỉ hoàn tiền của sàn lưu loại `refund`', async () => {
    const { externalOrderId } = await marketplaceOrder();
    const r = remoteReturn(externalOrderId, { kind: 'refund', rawStatus: 'REFUND_PENDING' });
    remote = [r];
    await pullShopReturns(company.companyId, shopId);
    expect(await requestOf(r.externalId)).toMatchObject({ kind: 'refund', status: 'requested' });
  });

  it('sàn báo trạng thái app không tới được: giữ trạng thái, bật Cần xử lý', async () => {
    const { externalOrderId } = await marketplaceOrder();
    const r = remoteReturn(externalOrderId, { rawStatus: 'REQUEST_REJECT', status: 'rejected' });
    remote = [r];
    await pullShopReturns(company.companyId, shopId);
    remote = [{ ...r, rawStatus: 'REQUEST_INITIATE', status: 'requested', updatedAt: new Date(Date.now() + 1000) }];
    await pullShopReturns(company.companyId, shopId);
    const row = await requestOf(r.externalId);
    expect(row).toMatchObject({ status: 'rejected', needs_attention: true, raw_marketplace_status: 'REQUEST_INITIATE' });
    expect(row.attention_note).toContain('REQUEST_INITIATE');
  });

  it('kiện còn đang giao khi sàn mở yêu cầu: kiện nhảy tới Đã giao kèm cờ, yêu cầu bật Cần xử lý', async () => {
    const { externalOrderId, orderId } = await marketplaceOrder('in_transit');
    const r = remoteReturn(externalOrderId);
    remote = [r];
    await pullShopReturns(company.companyId, shopId);
    const pkg = await db().query(`select status, needs_attention from "order".packages where order_id = $1`, [orderId]);
    expect(pkg.rows).toEqual([{ status: 'delivered', needs_attention: true }]);
    const row = await requestOf(r.externalId);
    expect(row.needs_attention).toBe(true);
    expect(row.attention_note).toContain('Đã giao');
  });
});

describe('kiện đang hoàn hoặc thất lạc khi sàn mở yêu cầu (25 §9, review #202 mục 5)', () => {
  it.each(['returning', 'lost'])('kiện %s giữ nguyên; yêu cầu và đơn bật Cần xử lý', async (status) => {
    const { externalOrderId, orderId } = await marketplaceOrder();
    await db().query(`update "order".packages set status = $2 where order_id = $1`, [orderId, status]);
    const r = remoteReturn(externalOrderId);
    remote = [r];
    await pullShopReturns(company.companyId, shopId);
    expect((await db().query(`select status from "order".packages where order_id = $1`, [orderId])).rows).toEqual([{ status }]);
    expect((await requestOf(r.externalId)).needs_attention).toBe(true);
    const order = await db().query(`select needs_attention, attention_note from "order".orders where id = $1`, [orderId]);
    expect(order.rows[0].needs_attention).toBe(true);
    expect(order.rows[0].attention_note).toContain((await requestOf(r.externalId)).code);
  });
});

describe('kiện đã hoàn về kho khi sàn mở yêu cầu (E109, 25 §9)', () => {
  it('giữ kiện `returned`, yêu cầu bật cờ; quét mã yêu cầu đi như kiện không khớp, không gọi kho nguồn yêu cầu', async () => {
    const { externalOrderId, orderId } = await marketplaceOrder();
    await db().query(`update "order".packages set status = 'returned' where order_id = $1`, [orderId]);
    const r = remoteReturn(externalOrderId, { rawStatus: 'REFUND_PENDING', status: 'awaiting_return' });
    remote = [r];
    await pullShopReturns(company.companyId, shopId);
    const row = await requestOf(r.externalId);
    expect(row).toMatchObject({ status: 'awaiting_return', needs_attention: true });
    const pkg = await db().query(`select status from "order".packages where order_id = $1`, [orderId]);
    expect(pkg.rows).toEqual([{ status: 'returned' }]);

    const calls: Parameters<ReturnStockPort['receiveBack']>[0][] = [];
    setReturnStockPort({
      async receiveBack(source) {
        calls.push(source);
        return { documentId: randomUUID(), number: 'KT-X' };
      },
    });
    try {
      const res = await request(testApp())
        .post('/api/v1/returns/receive')
        .set('Authorization', `Bearer ${company.ceo.token}`)
        .send({ code: row.code });
      expect(res.status).toBe(200);
      expect(res.body.kind).toBe('unmatched');
      expect(res.body.parcel.scannedCode).toBe(row.code);
      expect(calls.filter((c) => c.type === 'return_request')).toEqual([]);
      expect((await requestOf(r.externalId)).status).toBe('awaiting_return');
    } finally {
      setReturnStockPort();
    }
  });
});

describe('ca theo Documents (review #202 mục 12)', () => {
  it('E65: đơn đã hoàn tất vẫn nhận yêu cầu tới muộn; đơn giữ completed, mang cờ return_requested', async () => {
    const { externalOrderId, orderId } = await marketplaceOrder();
    await db().query(`update "order".orders set status = 'completed', outcome = 'full', completed_at = now() where id = $1`, [orderId]);
    const r = remoteReturn(externalOrderId);
    remote = [r];
    expect(await pullShopReturns(company.companyId, shopId)).toMatchObject({ created: 1 });
    const order = await request(testApp()).get(`/api/v1/sales/orders/${orderId}`).set('Authorization', `Bearer ${company.ceo.token}`);
    expect(order.body.status).toBe('completed');
    expect(order.body.flags).toContain('return_requested');
  });

  it.each(['requested', 'awaiting_return'] as const)('khách rút yêu cầu trên sàn từ %s: đóng buyer_cancelled', async (status) => {
    const { externalOrderId } = await marketplaceOrder();
    const r = remoteReturn(externalOrderId, { status, rawStatus: status === 'requested' ? 'REQUEST_INITIATE' : 'REFUND_PENDING' });
    remote = [r];
    await pullShopReturns(company.companyId, shopId);
    remote = [{ ...r, rawStatus: 'REQUEST_CANCEL', status: 'closed', closeResult: 'buyer_cancelled', updatedAt: new Date(Date.now() + 1000) }];
    await pullShopReturns(company.companyId, shopId);
    const row = await requestOf(r.externalId);
    expect(row).toMatchObject({ status: 'closed', close_result: 'buyer_cancelled', needs_attention: false, refunded: false });
    expect((await historyOf(row.id)).at(-1)).toEqual({ action: 'buyer_cancel', source: 'marketplace', to_status: 'closed' });
  });

  it('đã từ chối rồi sàn báo khách huỷ (người bán thắng, như TikTok): giữ rejected, không bật cờ', async () => {
    const { externalOrderId } = await marketplaceOrder();
    const r = remoteReturn(externalOrderId, { rawStatus: 'REFUND_REJECT', status: 'rejected' });
    remote = [r];
    await pullShopReturns(company.companyId, shopId);
    remote = [{ ...r, rawStatus: 'REQUEST_CANCEL', status: 'closed', closeResult: 'buyer_cancelled', updatedAt: new Date(Date.now() + 1000) }];
    await pullShopReturns(company.companyId, shopId);
    expect(await requestOf(r.externalId)).toMatchObject({ status: 'rejected', needs_attention: false, raw_marketplace_status: 'REQUEST_CANCEL' });
  });
});

describe('giá vốn dòng trả (25 §9, review #202 mục 4)', () => {
  const costsOf = async (requestId: string) =>
    (await db().query(`select unit_cost from "order".return_request_lines where request_id = $1`, [requestId])).rows.map((l) => (l.unit_cost === null ? null : Number(l.unit_cost)));

  it('chỉ tính dòng kiện đã giao (kể cả kiện vừa nhảy cóc), không tính kiện thất lạc', async () => {
    const lost = await marketplaceOrder();
    await db().query(`update "order".packages set status = 'lost' where order_id = $1`, [lost.orderId]);
    await db().query(`update "order".package_lines set unit_cost = 15000 where package_id in (select id from "order".packages where order_id = $1)`, [lost.orderId]);
    const r1 = remoteReturn(lost.externalOrderId);
    const moving = await marketplaceOrder('in_transit');
    await db().query(`update "order".package_lines set unit_cost = 18000 where package_id in (select id from "order".packages where order_id = $1)`, [moving.orderId]);
    const r2 = remoteReturn(moving.externalOrderId);
    remote = [r1, r2];
    await pullShopReturns(company.companyId, shopId);
    expect(await costsOf((await requestOf(r1.externalId)).id)).toEqual([null, null]);
    expect(await costsOf((await requestOf(r2.externalId)).id)).toEqual([18000, 18000]);
  });
});

describe('kiểm hàng hoàn xong (`inventory.return_inspected`)', () => {
  it('đóng yêu cầu `inspected`, chia số bán lại về dòng, tính giá vốn bán lại, hoàn tiền', async () => {
    const { externalOrderId } = await marketplaceOrder();
    const r = remoteReturn(externalOrderId, { rawStatus: 'REFUND_PENDING', status: 'awaiting_return' });
    remote = [r];
    await pullShopReturns(company.companyId, shopId);
    const row = await requestOf(r.externalId);
    const inspectionId = randomUUID();
    await db().query(`update "order".return_request_lines set unit_cost = 15000 where request_id = $1`, [row.id]);
    await db().query(
      `update "order".return_requests set status = 'received', received_at = now(), inspection_id = $2, inspection_number = 'KT-1', version = version + 1 where id = $1`,
      [row.id, inspectionId],
    );
    await withCompany(company.companyId, () => onReturnInspected({ payload: { inspectionId, lines: [{ variantId, resellable: 1 }] } }));

    const closed = await requestOf(r.externalId);
    expect(closed).toMatchObject({ status: 'closed', close_result: 'inspected', refunded: true });
    expect(Number(closed.resell_cost)).toBe(15000);
    const lines = await db().query(`select resell_qty from "order".return_request_lines where request_id = $1 order by external_line_id`, [row.id]);
    expect(lines.rows.map((l) => l.resell_qty).sort()).toEqual([0, 1]);
    // Nhận trùng sự kiện qua consumer thật: `processed_events` chặn lần hai, handler không chạy lại.
    const handler = vi.fn(onReturnInspected);
    const envelope = { eventId: randomUUID(), type: 'inventory.return_inspected', companyId: company.companyId, aggregateId: randomUUID(), occurredAt: new Date().toISOString(), payload: { inspectionId, orderId: closed.order_id, shopId, inspectedAt: new Date().toISOString(), lines: [{ variantId, resellable: 2, unitCost: null }] } };
    const message: IncomingMessage = { topic: 'commerio.inventory', partition: 0, offset: '1', key: null, headers: { type: 'inventory.return_inspected' }, value: Buffer.from(JSON.stringify(envelope)) };
    const deps = {
      spec: { consumer: `sales-return-inspected-${randomUUID().slice(0, 6)}`, scope: 'shared' as const, handlers: new Map([['inventory.return_inspected', handler as never]]) },
      retryDelaysMs: [],
      runHandler: async (e: { eventId: string; companyId: string | null }, h: (e: never) => Promise<void>) => {
        await withCompany(company.companyId, async () => {
          if (!(await markProcessed(deps.spec.consumer, e.eventId))) return;
          try {
            await h(e as never);
          } catch (err) {
            throw new HandlerFailure(err);
          }
        });
      },
      sendToDlq: async (_m: unknown, reason: string) => {
        throw new Error(`DLQ: ${reason}`);
      },
    };
    expect(await processMessage(message, 0, deps as never)).toEqual({ kind: 'done' });
    expect(await processMessage(message, 0, deps as never)).toEqual({ kind: 'done' });
    expect(handler).toHaveBeenCalledTimes(1);
    // Sự kiện khác (eventId mới) tới sau khi đã đóng: handler bỏ qua theo trạng thái.
    await withCompany(company.companyId, () => onReturnInspected({ payload: { inspectionId, lines: [{ variantId, resellable: 2 }] } }));
    expect((await requestOf(r.externalId)).version).toBe(closed.version);
  });
});
