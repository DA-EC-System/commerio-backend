import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signLazada } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';
import { checkRequest, signPush, signRequest } from '../../../../scripts/lazada-mock/sign.ts';

const params = { app_key: 'mock-app-key', timestamp: '1761634800000', sign_method: 'sha256', access_token: 't', order_id: '1' };

describe('chữ ký của sàn giả lập Lazada (#115)', () => {
  it('ký giống hệt adapter của app, bỏ qua tham số sign', () => {
    const sign = signLazada('/order/get', params, 'mock-app-secret');
    expect(signRequest('/order/get', params, 'mock-app-secret')).toBe(sign);
    expect(signRequest('/order/get', { ...params, sign }, 'mock-app-secret')).toBe(sign);
  });

  it('chữ ký đúng thì qua; sai secret, thiếu sign hay sửa một tham số thì IncompleteSignature', () => {
    const sign = signLazada('/order/get', params, 'mock-app-secret');
    expect(checkRequest('/order/get', { ...params, sign }, 'mock-app-key', 'mock-app-secret')).toEqual({ ok: true });
    const bad = (p: Record<string, string>) => checkRequest('/order/get', p, 'mock-app-key', 'mock-app-secret');
    expect(bad({ ...params, sign: signLazada('/order/get', params, 'khac') })).toMatchObject({ ok: false, code: 'IncompleteSignature' });
    expect(bad(params)).toMatchObject({ ok: false, code: 'IncompleteSignature' });
    expect(bad({ ...params, order_id: '2', sign })).toMatchObject({ ok: false, code: 'IncompleteSignature' });
    expect(checkRequest('/order/items/get', { ...params, sign }, 'mock-app-key', 'mock-app-secret')).toMatchObject({ ok: false });
  });

  it('app_key khác thì InvalidAppKey', () => {
    const p = { ...params, app_key: 'app-khac' };
    expect(checkRequest('/order/get', { ...p, sign: signRequest('/order/get', p, 'mock-app-secret') }, 'mock-app-key', 'mock-app-secret')).toMatchObject({
      ok: false,
      code: 'InvalidAppKey',
    });
  });

  it('push ký hex thường trên app_key + raw body (lazada.md §8)', () => {
    const raw = '{"seller_id":"1"}';
    expect(signPush(raw, 'k', 's')).toBe(createHmac('sha256', 's').update(`k${raw}`).digest('hex'));
    expect(signPush(raw, 'k', 's')).toMatch(/^[0-9a-f]{64}$/);
  });
});
