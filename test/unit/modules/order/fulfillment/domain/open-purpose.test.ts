// Thứ tự mục đích Cần mở (spec 237 §5.6, D17) và luật gỡ cờ khi kiện còn dòng chờ đổi ghép (D18).
import { describe, expect, it } from 'vitest';
import { purposeAfterClear, raisePurpose } from '#src/modules/order/fulfillment/domain/open-purpose.ts';

const flagged = (openPurpose: 'cancel' | 'edit' | 'resplit' | 'stocktake' | 'remap') => ({ needsOpen: true, openPurpose });
const none = { needsOpen: false, openPurpose: null };

describe('raisePurpose: thứ tự mục đích Cần mở (D17)', () => {
  it('D2-G11 kiện chưa có cờ, bật remap → Cần mở remap', () => {
    expect(raisePurpose(none, 'remap')).toEqual({ needsOpen: true, openPurpose: 'remap' });
  });
  it('D2-G11 stocktake bị remap thay (19b)', () => {
    expect(raisePurpose(flagged('stocktake'), 'remap')).toEqual({ needsOpen: true, openPurpose: 'remap' });
  });
  it('D2-G11 edit không bị remap thay', () => {
    expect(raisePurpose(flagged('edit'), 'remap')).toBeNull();
  });
  it('D2-G11 resplit không bị remap thay', () => {
    expect(raisePurpose(flagged('resplit'), 'remap')).toBeNull();
  });
  it('D2-G11 remap gặp remap: giữ (19e)', () => {
    expect(raisePurpose(flagged('remap'), 'remap')).toBeNull();
  });
  it('D2-G12 cancel không bị resplit thay', () => {
    expect(raisePurpose(flagged('cancel'), 'resplit')).toBeNull();
  });
  it('D2-G12 remap bị resplit thay (19d)', () => {
    expect(raisePurpose(flagged('remap'), 'resplit')).toEqual({ needsOpen: true, openPurpose: 'resplit' });
  });
  it('D2-G12 remap bị cancel thay (19d)', () => {
    expect(raisePurpose(flagged('remap'), 'cancel')).toEqual({ needsOpen: true, openPurpose: 'cancel' });
  });
  it('D2-G12 edit bị resplit thay (giữ hành vi cũ của #238)', () => {
    expect(raisePurpose(flagged('edit'), 'resplit')).toEqual({ needsOpen: true, openPurpose: 'resplit' });
  });
  it('D2-G12 kiện chưa cờ, bật cancel → Cần mở cancel', () => {
    expect(raisePurpose(none, 'cancel')).toEqual({ needsOpen: true, openPurpose: 'cancel' });
  });
});

describe('purposeAfterClear: gỡ cờ khi kiện còn đóng (D18)', () => {
  it('D2-G12 còn dòng có dấu chờ đổi ghép → mục đích thành remap, không gỡ (19c)', () => {
    expect(purposeAfterClear(true)).toEqual({ openPurpose: 'remap' });
  });
  it('D2-G12 không còn dấu → gỡ cờ', () => {
    expect(purposeAfterClear(false)).toEqual({ needsOpen: false, openPurpose: null });
  });
});
