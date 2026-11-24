// Dữ liệu chuẩn của nền tảng (Documents/21 mục 5.6, 5.7): danh mục, thuộc tính biến thể chuẩn. Là dòng nền tảng
// (`company_id` NULL) do migration ghi: `*_du-lieu-chung-chuyen` (#521, 12 nhóm, 4 thuộc tính) rồi `*_danh-muc-chuan-du-lieu`
// (#531, 27 danh mục, 23 thuộc tính; sinh từ file này và `spec-defaults.ts`). Đổi hằng số thì viết migration dữ liệu mới;
// test `du-lieu-chung.test.ts`, `danh-muc-chuan.test.ts` so DB với hằng. Nguồn: `.claude/issues/luong-san-pham/du-lieu-chuan.md`
// mục 2, 4, 5 (cố vấn duyệt thay Thành 22/11/2026).
import type { PlatformKind } from './specs.ts';

/** 27 danh mục theo thứ tự hiện (26 sát danh mục cấp 1 của các sàn, cộng "Khác"). */
export const DEFAULT_GROUPS = [
  'Thời trang nam',
  'Thời trang nữ',
  'Đồ lót & đồ ngủ',
  'Thời trang trẻ em',
  'Giày dép',
  'Túi xách & vali',
  'Phụ kiện thời trang',
  'Trang sức & đồng hồ',
  'Điện thoại & máy tính bảng',
  'Máy tính & laptop',
  'Phụ kiện điện thoại & máy tính',
  'Âm thanh, TV & máy ảnh',
  'Điện gia dụng',
  'Nhà bếp & phòng ăn',
  'Nhà cửa & trang trí',
  'Giặt giũ & vệ sinh nhà cửa',
  'Mỹ phẩm & chăm sóc da',
  'Chăm sóc cá nhân',
  'Sức khoẻ & thực phẩm chức năng',
  'Mẹ & bé',
  'Đồ chơi',
  'Thực phẩm & đồ uống',
  'Thú cưng',
  'Thể thao & dã ngoại',
  'Ô tô & xe máy',
  'Sách, văn phòng phẩm & dụng cụ',
  'Khác',
] as const;
export type DefaultGroup = (typeof DEFAULT_GROUPS)[number];

/** Danh mục nền tảng cũ (#521) giữ `id`, đổi tên (`product_groups.renamed_from`). Năm danh mục còn lại giữ cả tên. */
export const GROUP_RENAMES: Readonly<Record<string, DefaultGroup>> = {
  'Túi ví': 'Túi xách & vali',
  'Phụ kiện': 'Phụ kiện thời trang',
  'Mỹ phẩm & làm đẹp': 'Mỹ phẩm & chăm sóc da',
  'Nhà cửa & đời sống': 'Nhà cửa & trang trí',
  'Điện tử': 'Phụ kiện điện thoại & máy tính',
  'Thực phẩm': 'Thực phẩm & đồ uống',
  'Thể thao': 'Thể thao & dã ngoại',
};

/**
 * Danh mục hẹp hơn tách từ danh mục cũ (`product_groups.split_into`): FE gợi ý chuyển sản phẩm, người dùng tự xác nhận
 * (21 mục 5.7). Khoá là tên mới của danh mục cũ.
 */
export const GROUP_SPLITS: Readonly<Partial<Record<DefaultGroup, readonly DefaultGroup[]>>> = {
  'Thời trang nam': ['Đồ lót & đồ ngủ'],
  'Thời trang nữ': ['Đồ lót & đồ ngủ'],
  'Phụ kiện thời trang': ['Trang sức & đồng hồ'],
  'Phụ kiện điện thoại & máy tính': ['Điện thoại & máy tính bảng', 'Máy tính & laptop', 'Âm thanh, TV & máy ảnh', 'Điện gia dụng'],
  'Nhà cửa & trang trí': ['Nhà bếp & phòng ăn', 'Điện gia dụng', 'Giặt giũ & vệ sinh nhà cửa'],
  'Mỹ phẩm & chăm sóc da': ['Chăm sóc cá nhân', 'Sức khoẻ & thực phẩm chức năng'],
  'Mẹ & bé': ['Thời trang trẻ em', 'Đồ chơi'],
  'Thực phẩm & đồ uống': ['Thú cưng'],
  Khác: ['Ô tô & xe máy', 'Sách, văn phòng phẩm & dụng cụ', 'Thú cưng'],
};

export interface DefaultAttribute {
  readonly kind: PlatformKind;
  /** Tối đa 20 ký tự (CHECK `attributes_name_length`). */
  readonly name: string;
  /** `[giá trị, mã]` theo thứ tự hiện; giá trị ≤ 20 ký tự, mã `^[A-Z0-9]{1,6}$`. */
  readonly values: readonly (readonly [value: string, code: string])[];
}

const same = (...xs: string[]) => xs.map((x) => [x, x.toUpperCase()] as const);

/**
 * 23 thuộc tính biến thể chuẩn (21 mục 5.7), mỗi cái một `platformKind`; adapter tra sale prop của leaf theo kind
 * (`standardSalesAttributes`, 21 mục 18.8.3). Bốn cái đầu có từ #510: giá trị cũ giữ thứ tự, giá trị mới thêm cuối.
 */
export const DEFAULT_ATTRIBUTES: readonly DefaultAttribute[] = [
  {
    kind: 'color',
    name: 'Màu sắc',
    values: [
      ['Đen', 'DEN'], ['Trắng', 'TRANG'], ['Đỏ', 'DO'], ['Xanh dương', 'XANHDU'], ['Vàng', 'VANG'], ['Hồng', 'HONG'], ['Xám', 'XAM'],
      ['Be', 'BE'], ['Nâu', 'NAU'], ['Cam', 'CAM'], ['Xanh lá', 'XANHLA'], ['Xanh navy', 'NAVY'], ['Tím', 'TIM'], ['Bạc', 'BAC'],
      ['Vàng gold', 'GOLD'], ['Nhiều màu', 'NHIEUM'],
    ],
  },
  {
    kind: 'size',
    name: 'Kích cỡ',
    values: [
      ['S', 'S'], ['M', 'M'], ['L', 'L'], ['XL', 'XL'], ['XXL', 'XXL'], ['XS', 'XS'], ['3XL', '3XL'], ['Freesize', 'FREE'],
      ...same('28', '29', '30', '31', '32', '34', '36'),
      ['0–3 tháng', '03TH'], ['3–6 tháng', '36TH'], ['6–12 tháng', '612TH'], ['1–2 tuổi', '12T'], ['2–3 tuổi', '23T'],
      ['3–4 tuổi', '34T'], ['4–5 tuổi', '45T'], ['5–6 tuổi', '56T'], ['6–8 tuổi', '68T'], ['8–10 tuổi', '810T'], ['10–12 tuổi', '1012T'],
    ],
  },
  {
    kind: 'volume',
    name: 'Dung tích',
    values: [
      ['30ml', '30ML'], ['50ml', '50ML'], ['100ml', '100ML'], ['250ml', '250ML'], ['500ml', '500ML'], ['1L', '1L'], ['100g', '100G'],
      ['250g', '250G'], ['500g', '500G'], ['1kg', '1KG'], ['200ml', '200ML'], ['1,8L', '18L'], ['5L', '5L'],
    ],
  },
  {
    kind: 'flavor',
    name: 'Hương vị',
    values: [
      ['Nguyên bản', 'NGBAN'], ['Socola', 'SOCOLA'], ['Dâu', 'DAU'], ['Vani', 'VANI'], ['Matcha', 'MATCHA'], ['Cà phê', 'CAPHE'],
      ['Trà xanh', 'TRAXA'], ['Cay', 'CAY'], ['Thịt gà', 'GA'], ['Thịt bò', 'BO'], ['Cá hồi', 'CAHOI'],
    ],
  },
  { kind: 'shoe_size', name: 'Size giày', values: same('35', '36', '37', '38', '39', '40', '41', '42', '43', '44', '45') },
  { kind: 'bra_size', name: 'Cỡ áo ngực', values: same('70A', '70B', '75A', '75B', '75C', '80A', '80B', '80C', '85B', '85C') },
  {
    kind: 'age',
    name: 'Độ tuổi',
    values: [['0–6 tháng', '06TH'], ['6–12 tháng', '612TH'], ['1–3 tuổi', '13T'], ['3–6 tuổi', '36T'], ['Trên 6 tuổi', 'TREN6']],
  },
  { kind: 'ring_size', name: 'Cỡ nhẫn', values: same('6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17', '18') },
  {
    kind: 'storage',
    name: 'Dung lượng',
    values: [
      ...same('64GB', '128GB', '256GB', '512GB', '1TB'),
      ['4GB+64GB', '4G64'], ['8GB+128GB', '8G128'], ['8GB+256GB', '8G256'], ['12GB+256GB', '12G256'], ['16GB+512GB', '16G512'],
    ],
  },
  {
    kind: 'version',
    name: 'Phiên bản',
    values: [['Bản thường', 'THUONG'], ['Plus', 'PLUS'], ['Pro', 'PRO'], ['Pro Max', 'PROMAX'], ['Quốc tế', 'QUOCTE'], ['Chính hãng VN/A', 'VNA']],
  },
  {
    kind: 'screen_size',
    name: 'Cỡ màn hình',
    values: [['32 inch', '32IN'], ['43 inch', '43IN'], ['50 inch', '50IN'], ['55 inch', '55IN'], ['65 inch', '65IN'], ['75 inch', '75IN']],
  },
  {
    kind: 'connector',
    name: 'Cổng kết nối',
    values: [['Type-C', 'TYPEC'], ['Lightning', 'LIGHT'], ['Micro USB', 'MICRO'], ['USB-A', 'USBA'], ['Type-C to Lightning', 'C2L']],
  },
  { kind: 'length', name: 'Chiều dài', values: [['0,25m', '025M'], ['0,5m', '05M'], ['1m', '1M'], ['1,5m', '15M'], ['2m', '2M'], ['3m', '3M']] },
  {
    kind: 'battery_capacity',
    name: 'Dung lượng pin',
    values: [['5.000mAh', '5K'], ['10.000mAh', '10K'], ['20.000mAh', '20K'], ['30.000mAh', '30K']],
  },
  {
    kind: 'voltage',
    name: 'Điện áp',
    values: [['220V', '220V'], ['110V', '110V'], ['Chân dẹt', 'CHANDE'], ['Chân tròn', 'CHANTR'], ['Chân UK', 'CHANUK']],
  },
  { kind: 'power', name: 'Công suất', values: same('500W', '800W', '1000W', '1500W', '2000W') },
  {
    kind: 'weight',
    name: 'Khối lượng',
    values: [['100g', '100G'], ['200g', '200G'], ['250g', '250G'], ['500g', '500G'], ['1kg', '1KG'], ['2kg', '2KG'], ['5kg', '5KG']],
  },
  {
    kind: 'scent',
    name: 'Mùi hương',
    values: [
      ['Hoa hồng', 'HONG'], ['Oải hương', 'OAIHUO'], ['Hoa nhài', 'NHAI'], ['Cam chanh', 'CAMCHA'], ['Gỗ', 'GO'], ['Biển', 'BIEN'],
      ['Không mùi', 'KHMUI'],
    ],
  },
  {
    kind: 'pack',
    name: 'Quy cách',
    values: [
      ['1 cái', '1CAI'], ['Combo 2', 'CB2'], ['Combo 3', 'CB3'], ['Combo 5', 'CB5'], ['Hộp 10', 'HOP10'], ['Lốc 6', 'LOC6'], ['Thùng 24', 'THG24'],
    ],
  },
  {
    kind: 'diaper_size',
    name: 'Cỡ tã',
    values: [
      ['NB (dưới 5kg)', 'NB'], ['S (4–8kg)', 'S'], ['M (6–11kg)', 'M'], ['L (9–14kg)', 'L'], ['XL (12–17kg)', 'XL'], ['XXL (trên 15kg)', 'XXL'],
    ],
  },
  {
    kind: 'bed_size',
    name: 'Cỡ giường',
    values: [['1m×2m', '1X2'], ['1m2×2m', '12X2'], ['1m4×2m', '14X2'], ['1m6×2m', '16X2'], ['1m8×2m', '18X2'], ['2m×2m2', '2X22']],
  },
  { kind: 'style', name: 'Mẫu', values: [['Mẫu 1', 'M1'], ['Mẫu 2', 'M2'], ['Mẫu 3', 'M3']] },
  {
    kind: 'compatible_model',
    name: 'Dòng máy',
    values: [['iPhone 15', 'IP15'], ['iPhone 15 Pro', 'IP15P'], ['iPhone 16', 'IP16'], ['Samsung S24', 'SS24'], ['Samsung A55', 'SA55']],
  },
];
