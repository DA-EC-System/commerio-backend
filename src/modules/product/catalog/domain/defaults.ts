// Dữ liệu có sẵn của công ty mới (Documents/21 mục 11.3 `seedCompanyDefaults`). Migration `*_nhom-hang-du-lieu` chép
// cùng danh sách cho công ty có trước; test `company-defaults.test.ts` giữ hai nơi khớp nhau.

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
] as const;
