import { describe, expect, it } from 'vitest';
import { FOLD_FROM, FOLD_TO, foldVi } from '#src/modules/channel/channel/domain/fold-vi.ts';

describe('foldVi (#565): bỏ dấu, chữ thường', () => {
  it('bỏ mọi dấu thanh, dấu mũ, móc của tiếng Việt và đổi Đ/đ thành d', () => {
    expect(foldVi('Áo Thun Đen ĐẬM Ưu Đãi Hưởng Ứng Phở Bò Tái Nạm')).toBe('ao thun den dam uu dai huong ung pho bo tai nam');
    expect(foldVi('ẮẰẲẴẶ ẤẦẨẪẬ ẾỀỂỄỆ ỐỒỔỖỘ ỚỜỞỠỢ ỨỪỬỮỰ ỲỶỸỴÝ')).toBe('aaaaa aaaaa eeeee ooooo ooooo uuuuu yyyyy');
  });

  it('chuỗi tổ hợp (NFD, dấu tách rời) ra cùng kết quả với chuỗi dựng sẵn (NFC)', () => {
    const nfd = 'Đỏ, Xanh lá'.normalize('NFD');
    expect(foldVi(nfd)).toBe('do, xanh la');
  });

  it('giữ nguyên số, dấu câu, ký tự ngoài bảng chữ Latin', () => {
    expect(foldVi('Size M/L - 100% cotton · 2024 ★')).toBe('size m/l - 100% cotton · 2024 ★');
  });

  it('bảng cho SQL translate: hai chuỗi cùng số ký tự, nguồn không lặp, có cả Đ và đ', () => {
    expect([...FOLD_FROM].length).toBe([...FOLD_TO].length);
    expect(new Set(FOLD_FROM).size).toBe([...FOLD_FROM].length);
    expect(FOLD_FROM).toContain('Đ');
    expect(FOLD_FROM).toContain('đ');
  });
});
