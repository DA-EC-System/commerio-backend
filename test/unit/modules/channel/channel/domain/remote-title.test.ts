import { describe, expect, it } from 'vitest';
import { remoteTitleChanged, sentBaseline, snapshotBaseline } from '#src/modules/channel/channel/domain/remote-title.ts';

const at = new Date('2026-11-18T10:00:00Z');
const flagged = { status: 'live', remoteTitleAtMatch: 'Cốc A', remoteTitleEnAtMatch: 'Cup A', remoteTitleChangedAt: at };

describe('remoteTitleChanged (#396)', () => {
  it('có mốc giờ phát hiện và SKU còn trong bản sao: from là mốc, to là bản sao', () => {
    expect(remoteTitleChanged(flagged, { title: 'Cốc B', titleEn: null })).toEqual({ from: 'Cốc A', to: 'Cốc B', fromEn: 'Cup A', toEn: null, detectedAt: at });
  });

  it('không có cờ, SKU rời bản sao hoặc listing đã gỡ thì null', () => {
    expect(remoteTitleChanged({ ...flagged, remoteTitleChangedAt: null }, { title: 'Cốc B', titleEn: null })).toBeNull();
    expect(remoteTitleChanged(flagged, undefined)).toBeNull();
    expect(remoteTitleChanged({ ...flagged, status: 'delisted' }, { title: 'Cốc B', titleEn: null })).toBeNull();
  });
});

describe('mốc tên', () => {
  it('từ bản sao: lấy tên và tên tiếng Anh, chưa có giờ mốc (lần ghi bản sao sau lấy lại tên tiếng Anh); vắng bản sao thì trống', () => {
    expect(snapshotBaseline({ title: 'Cốc A', titleEn: 'Cup A' })).toEqual({
      remoteTitleAtMatch: 'Cốc A',
      remoteTitleEnAtMatch: 'Cup A',
      remoteTitleMatchedAt: null,
      remoteTitleChangedAt: null,
    });
    expect(snapshotBaseline(undefined)).toEqual({ remoteTitleAtMatch: null, remoteTitleEnAtMatch: null, remoteTitleMatchedAt: null, remoteTitleChangedAt: null });
  });

  it('sau khi app gửi tên: tên đã gửi, giữ tên tiếng Anh của bản sao, giờ mốc là lúc ghi', () => {
    expect(sentBaseline('Cốc mới', { titleEn: 'Cup A' }, at)).toEqual({
      remoteTitleAtMatch: 'Cốc mới',
      remoteTitleEnAtMatch: 'Cup A',
      remoteTitleMatchedAt: at,
      remoteTitleChangedAt: null,
    });
    expect(sentBaseline('Cốc mới', undefined, at).remoteTitleEnAtMatch).toBeNull();
  });
});
