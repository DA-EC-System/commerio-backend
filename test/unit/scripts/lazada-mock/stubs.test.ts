import { describe, expect, it } from 'vitest';
import { initialStates, type Mapping, mappingsFor, ORDER_ID, SCENARIOS } from '../../../../scripts/lazada-mock/stubs.ts';

const pathOf = (m: Mapping) => (m.request.urlPath ?? m.request.urlPathPattern) as string;
const body = (m: Mapping) => m.response.jsonBody as Record<string, unknown>;
const at = (ms: Mapping[], path: string, scenario: string, state: string) =>
  ms.filter((m) => pathOf(m) === `/rest${path}` && m.scenarioName === scenario && m.requiredScenarioState === state);

describe('stub của sàn giả lập Lazada (#115)', () => {
  it.each(Object.entries(SCENARIOS))('%s: mỗi trạng thái đơn có đủ stub đọc đơn, món, hành trình', (_, s) => {
    const ms = mappingsFor(s);
    for (const state of s.order) {
      for (const path of ['/orders/get', '/order/get', '/order/items/get', '/orders/items/get', '/logistic/order/trace']) {
        expect(at(ms, path, 'don', state), `${path} @ ${state}`).toHaveLength(1);
      }
      const orders = body(at(ms, '/orders/get', 'don', state)[0]!).data as { orders: { statuses: string[] }[] };
      expect(orders.orders[0]!.statuses).toEqual([state]);
    }
    expect(initialStates(s).don).toBe(s.order[0]);
  });

  // Kéo đơn bỏ đơn có `updated_at` không mới hơn bản đã lưu (#199): giờ cố định thì app không bao giờ thấy bước mới.
  // Kéo đơn theo lô (#267) lấy món ở `/orders/items/get`; thiếu stub thì sàn giả lập trả InvalidApiPath, đơn không về.
  it.each(Object.entries(SCENARIOS))('%s: /orders/items/get trả món của đơn theo từng bước, như /order/items/get', (_, s) => {
    const ms = mappingsFor(s);
    for (const state of s.order.includes('pending') ? [...s.order, 'canceled'] : s.order) {
      const batch = body(at(ms, '/orders/items/get', 'don', state)[0]!).data as { order_id: number; order_items: unknown[] }[];
      expect(batch.map((o) => o.order_id), state).toEqual([ORDER_ID]);
      expect(batch[0]!.order_items, state).toEqual(body(at(ms, '/order/items/get', 'don', state)[0]!).data);
    }
  });

  it.each(Object.entries(SCENARIOS))('%s: updated_at của /orders/get, /order/get, /order/items/get tăng nghiêm ngặt theo các bước', (_, s) => {
    const ms = mappingsFor(s);
    // Cùng cách đọc giờ của adapter (`lazadaTime` ở lazada.ts): 'YYYY-MM-DD HH:mm:ss +0700'.
    const time = (v: unknown) => {
      expect(v).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+0700$/);
      return Date.parse(String(v).replace(' ', 'T').replace(/ ([+-]\d{2})(\d{2})$/, '$1:$2'));
    };
    const steps = s.order.includes('pending') ? [...s.order, 'canceled'] : s.order;
    const timesAt = (state: string) => {
      const list = (body(at(ms, '/orders/get', 'don', state)[0]!).data as { orders: { updated_at: string; created_at: string }[] }).orders[0]!;
      const items = body(at(ms, '/order/items/get', 'don', state)[0]!).data as { updated_at: string }[];
      const one = at(ms, '/order/get', 'don', state)[0];
      const times = [list.updated_at, ...items.map((i) => i.updated_at), ...(one ? [(body(one).data as { updated_at: string }).updated_at] : [])];
      expect(new Set(times).size, `${state}: đơn và món cùng giờ`).toBe(1);
      expect(list.created_at).toBe('2026-10-28 09:15:00 +0700');
      return time(times[0]);
    };
    const times = steps.map(timesAt);
    expect(times[0]).toBe(Date.parse('2026-10-28T09:15:00+07:00'));
    for (let n = 1; n < times.length; n++) expect(times[n], `${steps[n - 1]} → ${steps[n]}`).toBeGreaterThan(times[n - 1]!);
  });

  it('mốc hành trình khớp updated_at của bước sàn báo', () => {
    const s = SCENARIOS['giao-that-bai']!;
    const ms = mappingsFor(s);
    const last = s.order.at(-1)!;
    type Trace = { result: { module: { package_detail_info_list: { logistic_detail_info_list: { detail_type: string; event_time: number }[] }[] }[] } };
    const events = (body(at(ms, '/logistic/order/trace', 'don', last)[0]!) as unknown as Trace).result.module[0]!.package_detail_info_list[0]!
      .logistic_detail_info_list;
    expect(events.map((e) => e.detail_type)).toEqual(['ready_to_ship', 'shipped', 'failed_delivery', 'shipped_back', 'shipped_back_success']);
    for (const e of events) {
      const order = (body(at(ms, '/orders/get', 'don', e.detail_type)[0]!).data as { orders: { updated_at: string }[] }).orders[0]!;
      expect(new Date(e.event_time).getTime(), e.detail_type).toBe(Date.parse(order.updated_at.replace(' ', 'T').replace(' +0700', '+07:00')));
    }
  });

  it('tên mapping không trùng, mapping bắt mọi đường dẫn có độ ưu tiên thấp nhất', () => {
    const ms = mappingsFor(SCENARIOS['giao-thanh-cong']!);
    expect(new Set(ms.map((m) => m.name)).size).toBe(ms.length);
    const catchAll = ms.find((m) => m.request.urlPathPattern === '/rest/.*')!;
    expect(catchAll.priority).toBe(Math.max(...ms.map((m) => m.priority)));
    expect(body(catchAll).code).toBe('InvalidApiPath');
  });

  it('pack chuyển pending → packed, RTS chuyển packed → ready_to_ship; món có kiện từ lúc packed', () => {
    const ms = mappingsFor(SCENARIOS['giao-thanh-cong']!);
    expect(at(ms, '/order/fulfill/pack', 'don', 'pending')[0]!.newScenarioState).toBe('packed');
    expect(at(ms, '/order/package/rts', 'don', 'packed')[0]!.newScenarioState).toBe('ready_to_ship');
    const items = (state: string) => body(at(ms, '/order/items/get', 'don', state)[0]!).data as { package_id: string }[];
    expect(items('pending')[0]!.package_id).toBe('');
    expect(items('packed')[0]!.package_id).toMatch(/^FP/);
    expect(body(at(ms, '/order/document/get', 'don', 'packed')[0]!).code).toBe('30012');
  });

  it('quyết toán lệch có phí cố định 8% và phí quảng cáo; quyết toán khớp thì không', () => {
    const fees = (name: string) => {
      const rows = body(at(mappingsFor(SCENARIOS[name]!), '/finance/transaction/details/get', 'don', 'delivered')[0]!).data as {
        fee_name: string;
        amount: string;
      }[];
      return rows.filter((r) => r.fee_name === 'Commission' || r.fee_name.startsWith('Sponsored')).map((r) => `${r.fee_name} ${r.amount}`);
    };
    expect(fees('giao-thanh-cong')).toEqual(['Commission -5160.00', 'Commission -5160.00']);
    expect(fees('quyet-toan-lech')).toEqual(['Commission -10320.00', 'Commission -10320.00', 'Sponsored Discovery - Top up -5000.00']);
  });

  it('payout cộng đúng các dòng: doanh thu + phí = tiền về', () => {
    const ms = mappingsFor(SCENARIOS['giao-thanh-cong']!);
    const payout = (body(at(ms, '/finance/payout/status/get', 'don', 'delivered')[0]!).data as Record<string, string>[])[0]!;
    expect(Number(payout.item_revenue) + Number(payout.fees_total)).toBe(Number(payout.payout));
    expect(payout.item_revenue).toBe('258000.00');
  });

  it('trả hàng: chấp nhận sang bước kế, chứa "refuse" thì từ chối; hoàn tiền xong có dòng hoàn trong quyết toán', () => {
    const s = SCENARIOS['tra-mot-phan']!;
    const ms = mappingsFor(s);
    const updates = at(ms, '/order/reverse/return/update', 'tra', 'REQUEST_INITIATE');
    expect(updates.map((m) => m.newScenarioState).sort()).toEqual(['AGREE_RETURN', 'REQUEST_REJECT', 'REQUEST_REJECT']);
    const rows = body(at(ms, '/finance/transaction/details/get', 'tra', 'REFUND_SUCCESS')[0]!).data as { fee_name: string }[];
    expect(rows.map((r) => r.fee_name)).toContain('Reversal Item Price');
    expect(initialStates(s)).toEqual({ don: 'delivered', tra: 'REQUEST_INITIATE' });
  });

  it('token hết hạn: mọi API trừ auth trả IllegalAccessToken; đổi code lấy token thì hết hạn chấm dứt', () => {
    const ms = mappingsFor(SCENARIOS['token-het-han']!);
    const expired = ms.find((m) => m.scenarioName === 'token' && m.request.urlPathPattern)!;
    expect(new RegExp(`^${expired.request.urlPathPattern as string}$`).test('/rest/orders/get')).toBe(true);
    expect(new RegExp(`^${expired.request.urlPathPattern as string}$`).test('/rest/auth/token/create')).toBe(false);
    expect(body(expired).code).toBe('IllegalAccessToken');
    expect(ms.find((m) => pathOf(m) === '/rest/auth/token/create' && m.scenarioName === 'token')!.newScenarioState).toBe('con-han');
    expect(initialStates(SCENARIOS['token-het-han']!).token).toBe('het-han');
  });
});
