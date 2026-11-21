import { describe, expect, it } from 'vitest';
import { stockToPushOf } from '#src/modules/channel/channel/domain/stock-to-push.ts';

// Tồn sẽ đẩy (Documents/21 §18.9 R3, §18.3 `match-preview`; 25 §6.4): cùng luật với việc đẩy tồn.
const base = { zeroHidden: false, holdStock: false, counted: true, available: 7 };

describe('stockToPushOf', () => {
  it('SKU đã có số, gian hàng không giữ tồn: đẩy số có thể bán', () => {
    expect(stockToPushOf(base)).toEqual({ stockToPush: 7, stockHeldReason: null });
  });

  it('gian hàng chờ kiểm kê lần đầu thắng SKU chưa có số', () => {
    expect(stockToPushOf({ ...base, holdStock: true, counted: false })).toEqual({ stockToPush: null, stockHeldReason: 'shop_waiting_opening' });
  });

  it('SKU kho chưa có số: không đẩy, lý do not_counted', () => {
    expect(stockToPushOf({ ...base, counted: false })).toEqual({ stockToPush: null, stockHeldReason: 'not_counted' });
  });

  it('listing ẩn bằng tồn 0 luôn gửi 0, kể cả khi giữ tồn hay chưa có số', () => {
    expect(stockToPushOf({ ...base, zeroHidden: true, holdStock: true, counted: false })).toEqual({ stockToPush: 0, stockHeldReason: null });
  });

  it('không đọc được số có thể bán: null, không có lý do giữ', () => {
    expect(stockToPushOf({ ...base, available: undefined })).toEqual({ stockToPush: null, stockHeldReason: null });
  });
});
