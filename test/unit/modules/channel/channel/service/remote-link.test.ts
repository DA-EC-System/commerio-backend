import { describe, expect, it } from 'vitest';
import { labelFromTitle } from '#src/modules/channel/channel/service/remote-link.ts';

// Nhãn biến thể tách từ tên SKU sàn "<tên sản phẩm> - <nhãn>" (KB3): phần đầu là tên chung của mọi SKU anh em.
describe('labelFromTitle', () => {
  it('tên sản phẩm có dấu " - " bên trong: lấy phần sau tên chung', () => {
    const titles = ['Son lì - bản thử - Đỏ', 'Son lì - bản thử - Cam'];
    expect(labelFromTitle(titles[1]!, titles)).toBe('Cam');
  });

  it('không có SKU anh em hoặc không có tên chung: null', () => {
    expect(labelFromTitle('Cốc - Trắng', ['Cốc - Trắng'])).toBeNull();
    expect(labelFromTitle('Cốc - Trắng', ['Cốc - Trắng', 'Bát - Đen'])).toBeNull();
  });
});
