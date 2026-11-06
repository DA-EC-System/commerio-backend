// Bộ ca hợp đồng dùng chung cho mọi adapter sàn (#200; Documents/tich-hop-san/README.md bước 7). Ca chỉ gọi interface
// `MarketplaceAdapter`; harness là chỗ duy nhất biết HTTP của sàn. Năng lực tuỳ chọn (`listOrders`, `getOrder`…) adapter
// chưa có thì ca của nó bỏ qua, để sàn mới qua bộ ca trước khi làm phần đơn.
import { describe, expect, it } from 'vitest';
import { ShopCapabilities } from '#src/modules/channel/channel/api/schemas.ts';
import {
  type MarketplaceAdapter,
  MarketplaceError,
  type RemoteLineStatus,
  type RemoteState,
} from '#src/modules/channel/channel/service/marketplaces/common.ts';

export interface AdapterHarness {
  /**
   * Adapter đủ cấu hình nối với sàn giả của harness. `orders` (mã đơn → `updatedAt` ms) là danh sách đơn trên sàn, harness
   * đọc lại mỗi lần gọi nên ca sửa được giữa hai trang.
   */
  connected(state?: { orders?: Map<string, number> }): MarketplaceAdapter;
  /** Adapter thiếu cấu hình; `calls()` đếm lời gọi mạng. */
  unconfigured(): { adapter: MarketplaceAdapter; calls: () => number };
  /** Adapter mà mọi lời gọi gặp lỗi mạng, HTTP 5xx, hay token bị sàn từ chối. */
  failing(mode: 'network' | 'http_5xx' | 'bad_token'): MarketplaceAdapter;
  /** Query hợp lệ sàn trả trên URL callback (trừ `state`). */
  callbackParams: Record<string, string>;
  /** Token hợp lệ cho `connectWithToken` và các hàm gọi sàn. */
  accessToken: string;
  /** SellerSku có trên sàn giả, cho `getSkus`. */
  sellerSkus: string[];
  /** Mã một đơn trên sàn giả, cho `getOrder`. */
  orderId: string;
}

const LINE_STATUSES: readonly RemoteLineStatus[] = [
  'pending',
  'packed',
  'awaiting_pickup',
  'in_transit',
  'delivered',
  'delivery_failed',
  'returning',
  'returned',
  'return_failed',
  'lost',
  'cancelled',
];
const REMOTE_STATES: readonly RemoteState[] = ['review', 'live', 'rejected', 'hold', 'inactive', 'deleted'];

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => undefined,
    (err: unknown) => err,
  );
}

export function describeAdapterContract(name: string, h: AdapterHarness): void {
  describe(`hợp đồng adapter: ${name}`, () => {
    it('capabilities đủ 4 trường, đúng giá trị cho phép', () => {
      expect(() => ShopCapabilities.parse(h.connected().capabilities)).not.toThrow();
    });

    it('connectMethods chỉ gồm oauth, token; có oauth thì URL uỷ quyền mang state', () => {
      const adapter = h.connected();
      const methods = adapter.connectMethods();
      expect(methods.length).toBeGreaterThan(0);
      for (const m of methods) expect(['oauth', 'token']).toContain(m);
      if (methods.includes('oauth')) {
        expect(new URL(adapter.authorizeUrl('st-hop-dong')).searchParams.get('state')).toBe('st-hop-dong');
      }
    });

    it('thiếu cấu hình: connectMethods rỗng, authorizeUrl và nối báo unsupported, không gọi mạng', async () => {
      const { adapter, calls } = h.unconfigured();
      expect(adapter.connectMethods()).toEqual([]);
      expect(() => adapter.authorizeUrl('st')).toThrow(expect.objectContaining({ kind: 'unsupported' }));
      expect(await errorOf(adapter.connectWithToken({ accessToken: h.accessToken, refreshToken: null }))).toMatchObject({
        kind: 'unsupported',
      });
      expect(calls()).toBe(0);
    });

    it('exchangeCode và connectWithToken ra ít nhất một gian hàng, mỗi gian hàng có mã shop và token riêng', async () => {
      const adapter = h.connected();
      for (const shops of [
        await adapter.exchangeCode(h.callbackParams),
        await adapter.connectWithToken({ accessToken: h.accessToken, refreshToken: null }),
      ]) {
        expect(shops.length).toBeGreaterThan(0);
        for (const s of shops) {
          expect(s.externalShopId).toMatch(/\S/);
          expect(typeof s.shopName).toBe('string');
          expect(s.region === null || /^[A-Z]{2}$/.test(s.region)).toBe(true);
          expect(s.tokens.accessToken).toMatch(/\S/);
        }
      }
    });

    it('callback thiếu tham số: MarketplaceError rejected, không TypeError', async () => {
      const err = await errorOf(h.connected().exchangeCode({}));
      expect(err).toBeInstanceOf(MarketplaceError);
      expect(err).toMatchObject({ kind: 'rejected' });
    });

    it.each([
      ['network', 'unavailable'],
      ['http_5xx', 'unavailable'],
      ['bad_token', 'unauthorized'],
    ] as const)('lỗi %s → MarketplaceError %s', async (mode, kind) => {
      const err = await errorOf(h.failing(mode).connectWithToken({ accessToken: h.accessToken, refreshToken: null }));
      expect(err).toBeInstanceOf(MarketplaceError);
      expect(err).toMatchObject({ kind });
    });

    it('getSkus chỉ trả SKU được hỏi, trạng thái thuộc tập chuẩn', async () => {
      const skus = await h.connected().getSkus(h.accessToken, h.sellerSkus);
      expect(skus.length).toBeGreaterThan(0);
      for (const s of skus) {
        expect(h.sellerSkus).toContain(s.sellerSku);
        expect(REMOTE_STATES).toContain(s.state);
      }
    });

    const probe = h.connected();

    // Đơn ở trang đã đọc đổi trạng thái thì nhảy xuống cuối danh sách: lật theo offset trần sẽ sót đơn kế tiếp (#218).
    it.skipIf(!probe.listOrders)('listOrders: đơn ở trang đã đọc đổi giữa hai trang không làm sót đơn, updatedAt không giảm, có điểm dừng', async () => {
      const base = Date.parse('2026-11-01T00:00:00Z');
      const ids = Array.from({ length: 250 }, (_, i) => `O${String(i + 1).padStart(3, '0')}`);
      const orders = new Map(ids.map((id, i) => [id, base + i * 1000]));
      const adapter = h.connected({ orders });
      const seen = new Set<string>();
      let last = 0;
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = await adapter.listOrders!(h.accessToken, new Date(base - 120_000), cursor);
        for (const o of page.orders) {
          expect(o.updatedAt.getTime()).toBeGreaterThanOrEqual(last);
          last = o.updatedAt.getTime();
          seen.add(o.externalOrderId);
        }
        expect(page.safeUntil === null || page.safeUntil instanceof Date).toBe(true);
        cursor = page.nextCursor;
        if (++pages === 1 && cursor) orders.set(page.orders[0]!.externalOrderId, base + 3600_000);
        expect(pages).toBeLessThan(50);
      } while (cursor);
      for (const id of ids) expect(seen).toContain(id);
    });

    it.skipIf(!probe.getOrder)('getOrder: trạng thái món chuẩn hoá về tập chuẩn hoặc null, giữ mã gốc', async () => {
      const order = await h.connected().getOrder!(h.accessToken, h.orderId);
      expect(order.externalOrderId).toBe(h.orderId);
      expect(order.lines.length).toBeGreaterThan(0);
      for (const l of order.lines) {
        expect(l.status === null || LINE_STATUSES.includes(l.status)).toBe(true);
        expect(typeof l.rawStatus).toBe('string');
      }
    });

    // Năng lực lấy đơn theo lô (#267): bên gọi dùng thay `getOrder` từng đơn, nên dữ liệu phải y hệt.
    it.skipIf(!probe.getOrders || !probe.getOrder)('getOrders: cùng thứ tự với refs, mỗi đơn giống getOrder', async () => {
      const adapter = h.connected();
      const at = new Date('2026-11-01T00:00:00Z');
      const refs = [h.orderId, h.orderId].map((id) => ({ externalOrderId: id, placedAt: at, updatedAt: at }));
      const many = await adapter.getOrders!(h.accessToken, refs);
      const one = await adapter.getOrder!(h.accessToken, h.orderId);
      expect(many).toEqual([one, one]);
      expect(await adapter.getOrders!(h.accessToken, [])).toEqual([]);
    });
  });
}
