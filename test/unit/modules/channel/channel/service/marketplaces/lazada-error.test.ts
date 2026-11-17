import { describe, expect, it } from 'vitest';
import { lazadaError } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';

// #359: lỗi tạm theo danh sách cho phép; mã nghiệp vụ mang type ISP (mã số hay mã chữ) là sàn từ chối.
describe('lazadaError: danh sách lỗi tạm (#359)', () => {
  it('AC-1: mã chữ nghiệp vụ mang type ISP là sàn từ chối, giữ mã và câu của sàn', () => {
    // Payload thật trên staging (issue #359): gỡ sản phẩm đã tắt trên Lazada.
    const err = lazadaError({ code: 'E0004', type: 'ISP', message: 'Product Status not online' });
    expect(err).toMatchObject({ kind: 'rejected', platformCode: 'E0004', platformMessage: 'Product Status not online' });
    expect(lazadaError({ code: 'SellerNotActive', type: 'ISP', message: 'x' }).kind).toBe('rejected');
    expect(lazadaError({ code: 'EDIT_ITEM_NOT_BELONG_SELLER', type: 'ISP', message: 'x' }).kind).toBe('rejected');
  });

  it.each(['ServiceUnavailable', 'ServiceTimeout', 'ApiCallLimit', 'SellerCallLimit', 'E0006', '6', '901', '1000', '4154'])(
    'AC-2: %s là lỗi tạm',
    (code) => {
      expect(lazadaError({ code, type: 'ISP', message: 'x' })).toMatchObject({ kind: 'unavailable', platformCode: code });
    },
  );

  it('AC-2: type SYSTEM là lỗi tạm dù mã lạ; mã token là unauthorized kể cả type ISP; mã số nghiệp vụ là rejected', () => {
    expect(lazadaError({ code: 'SomethingNew', type: 'SYSTEM', message: 'x' }).kind).toBe('unavailable');
    expect(lazadaError({ code: 'IllegalAccessToken', type: 'ISP', message: 'x' }).kind).toBe('unauthorized');
    expect(lazadaError({ code: '501', type: 'ISP', message: 'E501: Update product failed' }).kind).toBe('rejected');
  });
});
