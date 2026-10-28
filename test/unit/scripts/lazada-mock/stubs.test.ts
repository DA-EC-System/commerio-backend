import { describe, expect, it } from 'vitest';
import { initialStates, type Mapping, mappingsFor, SCENARIOS } from '../../../../scripts/lazada-mock/stubs.ts';

const pathOf = (m: Mapping) => (m.request.urlPath ?? m.request.urlPathPattern) as string;
const body = (m: Mapping) => m.response.jsonBody as Record<string, unknown>;
const at = (ms: Mapping[], path: string, scenario: string, state: string) =>
  ms.filter((m) => pathOf(m) === `/rest${path}` && m.scenarioName === scenario && m.requiredScenarioState === state);

describe('stub của sàn giả lập Lazada (#115)', () => {
  it.each(Object.entries(SCENARIOS))('%s: mỗi trạng thái đơn có đủ stub đọc đơn, món, hành trình', (_, s) => {
    const ms = mappingsFor(s);
    for (const state of s.order) {
      for (const path of ['/orders/get', '/order/get', '/order/items/get', '/logistic/order/trace']) {
        expect(at(ms, path, 'don', state), `${path} @ ${state}`).toHaveLength(1);
      }
      const orders = body(at(ms, '/orders/get', 'don', state)[0]!).data as { orders: { statuses: string[] }[] };
      expect(orders.orders[0]!.statuses).toEqual([state]);
    }
    expect(initialStates(s).don).toBe(s.order[0]);
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
