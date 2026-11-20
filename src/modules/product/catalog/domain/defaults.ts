// Dữ liệu có sẵn của công ty mới (Documents/21 mục 11.3 `seedCompanyDefaults`). Migration `*_nhom-hang-du-lieu` chép
// cùng danh sách cho công ty có trước ("Dung tích", "Hương vị" ở `*_thong-so-du-lieu`); test `company-defaults.test.ts` giữ
// hai nơi khớp nhau. Thư viện thông số, mẫu nhóm ở `spec-defaults.ts`.

export const DEFAULT_GROUPS = [
  'Thời trang nam',
  'Thời trang nữ',
  'Giày dép',
  'Túi ví',
  'Phụ kiện',
  'Mỹ phẩm & làm đẹp',
  'Nhà cửa & đời sống',
  'Điện tử',
  'Thực phẩm',
  'Mẹ & bé',
  'Thể thao',
  'Khác',
] as const;

/** Thuộc tính chuẩn sàn; `values` là `[giá trị, mã]` theo thứ tự hiện. */
export const DEFAULT_ATTRIBUTES = [
  {
    kind: 'color',
    name: 'Màu sắc',
    values: [
      ['Đen', 'DEN'],
      ['Trắng', 'TRANG'],
      ['Đỏ', 'DO'],
      ['Xanh dương', 'XANHDU'],
      ['Vàng', 'VANG'],
      ['Hồng', 'HONG'],
      ['Xám', 'XAM'],
      ['Be', 'BE'],
    ],
  },
  {
    kind: 'size',
    name: 'Kích cỡ',
    values: [
      ['S', 'S'],
      ['M', 'M'],
      ['L', 'L'],
      ['XL', 'XL'],
      ['XXL', 'XXL'],
    ],
  },
  // Trục chuẩn của Mỹ phẩm, Thực phẩm (thông số sản phẩm, research P4, Documents/21 mục 5.5; 21/11/2026).
  {
    kind: 'volume',
    name: 'Dung tích',
    values: [
      ['30ml', '30ML'],
      ['50ml', '50ML'],
      ['100ml', '100ML'],
      ['250ml', '250ML'],
      ['500ml', '500ML'],
      ['1L', '1L'],
      ['100g', '100G'],
      ['250g', '250G'],
      ['500g', '500G'],
      ['1kg', '1KG'],
    ],
  },
  {
    kind: 'flavor',
    name: 'Hương vị',
    values: [
      ['Nguyên bản', 'NGBAN'],
      ['Socola', 'SOCOLA'],
      ['Dâu', 'DAU'],
      ['Vani', 'VANI'],
      ['Matcha', 'MATCHA'],
      ['Cà phê', 'CAPHE'],
    ],
  },
] as const;
