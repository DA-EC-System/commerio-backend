// Thư viện thông số và mẫu của 12 nhóm mặc định (Documents/21 mục 5.5 "Seed", 19 §3.2). Nguồn:
// `.claude/issues/thong-so-san-pham/research.md` mục 3 (gọi API thật 68 leaf Lazada, TikTok; gộp `market.md`), ngày 21/11/2026.
// Migration `*_thong-so-du-lieu` sinh từ file này (scripts/db/gen-spec-seed.ts); test `company-defaults.test.ts` giữ hai nơi khớp.
//
// Ba luật của contract áp lên research:
// - Một thông số mỗi khái niệm: trường cùng tên ở nhiều nhóm là một thông số, lựa chọn là hợp các nhóm (channel ánh xạ
//   mỗi mã sàn từ một thông số; unique `(company, platform, attribute_code)`).
// - `required` chỉ khi luật nhãn đòi cho cả nhóm (NĐ 43/2017 PL I, TT 06/2011/TT-BYT) hoặc mọi sàn có adapter đều đòi;
//   thông số chỉ một sàn đòi (giấy phép TikTok `102872`…) để tuỳ chọn, sàn đó chặn qua `missing`.
// - Thuộc tính đã là trục của nhóm không là thông số của cha: Mỹ phẩm bỏ "Dung tích / Khối lượng", Thực phẩm bỏ
//   "Khối lượng tịnh" (trục `volume`).
import type { PlatformKind, SpecInputKind as SpecInput } from './specs.ts';

export interface DefaultSpecField {
  readonly code: string;
  readonly name: string;
  readonly input: SpecInput;
  readonly unit?: string;
  readonly allowCustom: boolean;
  readonly options?: readonly string[];
}

const sel = (code: string, name: string, options: readonly string[], allowCustom = true): DefaultSpecField => ({ code, name, input: 'select', allowCustom, options });
const multi = (code: string, name: string, options: readonly string[]): DefaultSpecField => ({ code, name, input: 'multiselect', allowCustom: true, options });
const text = (code: string, name: string): DefaultSpecField => ({ code, name, input: 'text', allowCustom: false });
const num = (code: string, name: string, unit: string): DefaultSpecField => ({ code, name, input: 'number', unit, allowCustom: false });

/** Thư viện thông số mặc định, theo thứ tự tạo. `code` khớp seed ánh xạ của channel (`seedSpecMappings`). */
export const DEFAULT_SPEC_FIELDS: readonly DefaultSpecField[] = [
  // Trường chung (21 §5.5, Luật Chất lượng SPHH Điều 34b): không mã sàn.
  text('huong_dan_su_dung', 'Hướng dẫn sử dụng, bảo quản'),
  text('canh_bao', 'Cảnh báo'),
  sel('hop_quy', 'Hợp quy', ['Không thuộc diện', 'Có dấu CR'], false),
  text('so_hop_quy', 'Số chứng nhận hợp quy'),
  // Thời trang, giày, túi, thể thao, mẹ & bé, nhà cửa, phụ kiện, khác.
  multi('chat_lieu', 'Chất liệu', [
    'Cotton', 'Cotton pha (CVC)', 'Polyester', 'Thun co giãn (Spandex)', 'Kaki', 'Denim', 'Lanh', 'Lụa', 'Nỉ', 'Len', 'Nylon',
    'Voan', 'Ren', 'Tuyết mưa', 'Đũi', 'Satin', 'Da thật', 'Da tổng hợp (PU)', 'Vải canvas', 'Vải lưới', 'Cao su', 'Nhựa EVA',
    'Vải dù', 'Nhựa PVC', 'Thép không gỉ', 'Hợp kim', 'Bạc', 'Vải', 'Nhựa', 'Gỗ', 'Thuỷ tinh', 'Inox', 'Gốm sứ', 'Tre', 'Nhôm',
    'Cotton hữu cơ', 'Sợi tre', 'Silicone', 'Nhựa PP', 'PPSU', 'Vải mè (lưới)', 'TPE', 'Giấy', 'Kim loại',
  ]),
  sel('hoa_tiet', 'Họa tiết', ['Trơn', 'Kẻ sọc', 'Kẻ ô (caro)', 'In chữ', 'In hình', 'Hoa', 'Hoa nhí', 'Chấm bi', 'Rằn ri']),
  sel('dang', 'Dáng', ['Ôm (Slim fit)', 'Suông (Regular)', 'Rộng (Oversize)', 'Chữ A', 'Bó (bodycon)', 'Xòe']),
  sel('co_ao', 'Cổ áo', ['Cổ tròn', 'Cổ tim', 'Cổ bẻ (polo)', 'Cổ sơ mi', 'Cổ trụ', 'Có mũ', 'Cổ vuông', 'Cổ yếm', 'Trễ vai']),
  sel('do_dai_tay', 'Độ dài tay', ['Không tay', 'Ngắn tay', 'Tay lửng', 'Dài tay']),
  sel('kieu_quan', 'Kiểu quần', ['Ống đứng', 'Ôm (skinny)', 'Ống rộng', 'Ống loe', 'Jogger', 'Cargo']),
  sel('cap_quan', 'Cạp quần', ['Cạp thấp', 'Cạp thường', 'Cạp cao']),
  sel('do_dai_vay', 'Độ dài váy/đầm', ['Mini', 'Trên gối', 'Ngang gối', 'Midi', 'Maxi']),
  multi('trang_tri', 'Trang trí', ['Không', 'Bèo nhún', 'Ren', 'Nơ', 'Thêu', 'Đính hạt', 'Xếp ly']),
  multi('phong_cach', 'Phong cách', [
    'Basic', 'Công sở', 'Đường phố', 'Thể thao', 'Hàn Quốc', 'Vintage', 'Dự tiệc', 'Tiểu thư', 'Thường ngày', 'Thanh lịch', 'Cổ điển',
  ]),
  multi('dip_mac', 'Dịp mặc', ['Hằng ngày', 'Công sở', 'Dự tiệc', 'Đi biển', 'Thể thao', 'Lễ tết']),
  multi('mua', 'Mùa', ['Xuân', 'Hè', 'Thu', 'Đông', 'Bốn mùa']),
  multi('tinh_nang', 'Tính năng', ['Co giãn', 'Khô nhanh', 'Thấm hút mồ hôi', 'Chống tia UV', 'Thoáng khí', 'Chống trượt', 'Chống nước']),
  multi('huong_dan_giat', 'Hướng dẫn giặt', ['Giặt máy', 'Giặt tay', 'Giặt nước lạnh', 'Không giặt khô', 'Không tẩy', 'Là nhiệt độ thấp']),
  sel('doi_tuong', 'Đối tượng', ['Nam', 'Nữ', 'Unisex']),
  sel('kieu_buoc', 'Kiểu buộc', ['Dây buộc', 'Xỏ (slip-on)', 'Khoá dán', 'Khoá kéo', 'Quai']),
  sel('chat_lieu_de', 'Chất liệu đế', ['Cao su', 'EVA', 'TPU', 'TPR', 'PVC']),
  sel('co_giay', 'Cổ giày', ['Cổ thấp', 'Cổ vừa', 'Cổ cao']),
  sel('do_cao_got', 'Độ cao gót', ['Không gót', 'Dưới 3 cm', '3–5 cm', '5–8 cm', 'Trên 8 cm']),
  multi('dac_diem', 'Đặc điểm', [
    'Nhẹ', 'Thoáng khí', 'Chống trượt', 'Chống nước', 'Êm chân', 'Chống trộm', 'Nhiều ngăn', 'Có ngăn laptop', 'Cổng USB',
    'Chống dính', 'Dùng được lò vi sóng', 'Dùng được máy rửa bát', 'Có nắp', 'Xếp chồng được',
  ]),
  sel('be_rong', 'Bề rộng', ['Hẹp', 'Thường', 'Rộng']),
  sel('chat_lieu_lot', 'Chất liệu lót', ['Da', 'Vải lưới', 'Cotton', 'Nỉ']),
  sel('loai_tui', 'Loại túi', ['Túi đeo chéo', 'Túi đeo vai', 'Túi xách tay', 'Túi tote', 'Ba lô', 'Ví dài', 'Ví ngắn', 'Ví đựng thẻ']),
  sel('kieu_khoa', 'Kiểu khoá', ['Khoá kéo', 'Nút bấm', 'Nam châm', 'Khoá gài', 'Dây rút']),
  sel('loai_da_thuoc', 'Loại da thuộc', ['Da bò', 'Da cừu', 'Da dê', 'Không phải da']),
  sel('co_tui', 'Cỡ túi', ['Mini', 'Nhỏ', 'Vừa', 'Lớn']),
  text('kich_thuoc', 'Kích thước'),
  multi('cach_mang', 'Cách mang', ['Quai xách', 'Dây đeo vai', 'Dây đeo chéo', 'Quai ba lô', 'Dây tháo rời']),
  num('dung_tich_lit', 'Dung tích (lít)', 'L'),
  num('dung_tich_ml', 'Dung tích (ml)', 'ml'),
  // Mỹ phẩm.
  multi('loai_da', 'Loại da', ['Mọi loại da', 'Da dầu', 'Da khô', 'Da hỗn hợp', 'Da nhạy cảm', 'Da mụn', 'Da thường']),
  multi('cong_dung', 'Công dụng', ['Dưỡng ẩm', 'Làm sáng', 'Chống lão hoá', 'Kiềm dầu', 'Trị mụn', 'Làm dịu', 'Chống nắng']),
  sel('dang_san_pham', 'Dạng sản phẩm', ['Kem', 'Gel', 'Lotion', 'Serum', 'Dầu', 'Xịt', 'Thỏi', 'Lỏng']),
  sel('han_su_dung', 'Hạn sử dụng', ['3 tháng', '6 tháng', '9 tháng', '12 tháng', '18 tháng', '24 tháng', '36 tháng']),
  sel('chi_so_chong_nang', 'Chỉ số chống nắng', ['SPF 15', 'SPF 30', 'SPF 50', 'SPF 50+']),
  sel('chi_so_pa', 'Chỉ số PA', ['PA+', 'PA++', 'PA+++', 'PA++++']),
  sel('hoan_thien', 'Hoàn thiện', ['Lì (matte)', 'Bóng', 'Satin', 'Tự nhiên']),
  text('thanh_phan', 'Thành phần'),
  // Giấy phép (TikTok `102872`, `102999`, `103000`, `103001`): mỹ phẩm, thực phẩm, mẹ & bé.
  sel('loai_giay_phep', 'Loại giấy phép', [
    'Phiếu công bố sản phẩm mỹ phẩm', 'Bản tự công bố sản phẩm', 'Giấy tiếp nhận đăng ký bản công bố', 'Giấy công bố tiêu chuẩn',
    'Giấy công bố hợp quy', 'Giấy chứng nhận cơ sở đủ điều kiện ATTP',
  ]),
  text('so_giay_phep', 'Số công bố, đăng ký'),
  { code: 'ngay_cap', name: 'Ngày cấp', input: 'date', allowCustom: false },
  text('noi_cap', 'Nơi cấp'),
  // Nhà cửa.
  num('so_mon', 'Số món trong bộ', 'món'),
  multi('bep_tuong_thich', 'Bếp tương thích', ['Bếp từ', 'Bếp gas', 'Bếp hồng ngoại', 'Bếp điện']),
  sel('lop_chong_dinh', 'Lớp chống dính', ['Ceramic', 'PTFE (Teflon)', 'Men', 'Anod cứng', 'Không phủ']),
  text('so_tu_cong_bo', 'Số bản tự công bố'),
  sel('loai_bao_hanh', 'Loại bảo hành', ['Bảo hành nhà sản xuất', 'Bảo hành người bán', 'Bảo hành quốc tế', 'Không bảo hành']),
  // Điện tử.
  sel('thoi_han_bao_hanh', 'Thời hạn bảo hành', ['1 tháng', '3 tháng', '6 tháng', '12 tháng', '24 tháng']),
  text('model', 'Model'),
  sel('tinh_trang', 'Tình trạng', ['Mới', 'Tân trang', 'Đã qua sử dụng'], false),
  multi('cong_ket_noi', 'Cổng kết nối', ['USB-C', 'Lightning', 'Micro USB', 'USB-A', 'Jack 3.5 mm']),
  num('dung_luong_pin', 'Dung lượng pin', 'mAh'),
  sel('bluetooth', 'Bluetooth', ['5.0', '5.1', '5.2', '5.3', '5.4']),
  sel('sac_nhanh', 'Sạc nhanh', ['Có', 'Không'], false),
  sel('chua_pin', 'Chứa pin', ['Không có pin', 'Pin tích hợp', 'Pin rời'], false),
  multi('thiet_bi_tuong_thich', 'Thiết bị tương thích', ['Apple', 'Samsung', 'Xiaomi', 'Oppo', 'Laptop']),
  sel('dien_ap', 'Điện áp', ['5V (USB)', '12V', '220V~50Hz', 'Dùng pin']),
  num('cong_suat', 'Công suất', 'W'),
  sel('chuan_chong_nuoc', 'Chuẩn chống nước', ['Không', 'IPX4', 'IPX5', 'IPX7', 'IP67', 'IP68']),
  // Thực phẩm.
  sel('loai_thuc_pham', 'Loại thực phẩm', ['Thực phẩm thường', 'Thực phẩm bảo vệ sức khoẻ', 'Thực phẩm bổ sung', 'Đồ uống', 'Rượu bia'], false),
  sel('cach_bao_quan', 'Cách bảo quản', ['Nhiệt độ phòng', 'Ngăn mát', 'Ngăn đông', 'Nơi khô ráo']),
  sel('loai_bao_bi', 'Loại bao bì', ['Túi', 'Hộp', 'Lon', 'Chai', 'Hũ', 'Thùng']),
  sel('huu_co', 'Hữu cơ', ['Có', 'Không'], false),
  multi('di_ung', 'Thông tin dị ứng', ['Sữa', 'Trứng', 'Cá', 'Tôm cua', 'Đậu phộng', 'Các loại hạt', 'Đậu nành', 'Lúa mì (gluten)', 'Mè']),
  // Mẹ & bé, khác.
  multi('do_tuoi', 'Độ tuổi phù hợp', [
    '0–3 tháng', '3–6 tháng', '6–12 tháng', '1–2 tuổi', '2–3 tuổi', '3–6 tuổi', '3+', '6+', '12+', 'Người lớn',
  ]),
  sel('loai_san_pham_be', 'Loại sản phẩm', ['Quần áo', 'Tã bỉm', 'Bình sữa & đồ ăn dặm', 'Đồ chơi', 'Sữa & dinh dưỡng', 'Đồ dùng khác']),
  sel('gioi_tinh_be', 'Giới tính bé', ['Bé trai', 'Bé gái', 'Unisex']),
  multi('an_toan_vat_lieu', 'An toàn vật liệu', ['Không BPA', 'Không phthalate', 'Không chất độc hại']),
  num('so_mieng_ta', 'Số miếng mỗi gói', 'miếng'),
  sel('loai_ta', 'Loại tã', ['Tã dán', 'Tã quần', 'Tã bơi']),
  // Thể thao.
  multi('mon_the_thao', 'Môn thể thao', ['Chạy bộ', 'Gym', 'Yoga', 'Bóng đá', 'Cầu lông', 'Tennis', 'Bơi', 'Đạp xe']),
  num('khoi_luong_san_pham', 'Khối lượng sản phẩm', 'kg'),
];

/** Mẫu một nhóm: trục chuẩn theo `platform_kind` (thuộc tính mang loại đó), thông số `[code, bắt buộc]` theo thứ tự hiện. */
export interface DefaultGroupTemplate {
  readonly group: string;
  readonly axes: readonly PlatformKind[];
  readonly fields: readonly (readonly [code: string, required: boolean])[];
}

const B = true;
const T = false;
const LICENSE = [['loai_giay_phep', T], ['so_giay_phep', T], ['ngay_cap', T], ['noi_cap', T]] as const;

export const DEFAULT_GROUP_TEMPLATES: readonly DefaultGroupTemplate[] = [
  {
    group: 'Thời trang nam',
    axes: ['color', 'size'],
    // PL I mục 25: thành phần, hướng dẫn sử dụng, bảo quản (giặt, là).
    fields: [
      ['chat_lieu', B], ['hoa_tiet', T], ['dang', T], ['co_ao', T], ['do_dai_tay', T], ['kieu_quan', T], ['cap_quan', T],
      ['phong_cach', T], ['dip_mac', T], ['tinh_nang', T], ['mua', T], ['huong_dan_giat', B],
    ],
  },
  {
    group: 'Thời trang nữ',
    axes: ['color', 'size'],
    fields: [
      ['chat_lieu', B], ['huong_dan_giat', B], ['hoa_tiet', T], ['dang', T], ['do_dai_vay', T], ['co_ao', T], ['do_dai_tay', T],
      ['cap_quan', T], ['trang_tri', T], ['phong_cach', T], ['dip_mac', T], ['mua', T],
    ],
  },
  {
    group: 'Giày dép',
    axes: ['color', 'size'],
    fields: [
      ['chat_lieu', B], ['doi_tuong', T], ['kieu_buoc', T], ['chat_lieu_de', T], ['co_giay', T], ['do_cao_got', T], ['dac_diem', T],
      ['be_rong', T], ['chat_lieu_lot', T], ['huong_dan_su_dung', T],
    ],
  },
  {
    group: 'Túi ví',
    axes: ['color'],
    fields: [
      ['chat_lieu', B], ['loai_tui', T], ['kieu_khoa', T], ['loai_da_thuoc', T], ['co_tui', T], ['kich_thuoc', T], ['cach_mang', T],
      ['dung_tich_lit', T], ['dac_diem', T], ['doi_tuong', T],
    ],
  },
  { group: 'Phụ kiện', axes: ['color'], fields: [['chat_lieu', T], ['doi_tuong', T], ['phong_cach', T]] },
  {
    group: 'Mỹ phẩm & làm đẹp',
    axes: ['color', 'volume'],
    // TT 06/2011/TT-BYT Điều 18 khoản 1: chức năng, hướng dẫn sử dụng, thành phần INCI, lưu ý an toàn.
    fields: [
      ['thanh_phan', B], ['huong_dan_su_dung', B], ['canh_bao', B], ['cong_dung', B], ['loai_da', T], ['han_su_dung', T],
      ['dang_san_pham', T], ['chi_so_chong_nang', T], ['chi_so_pa', T], ['hoan_thien', T], ...LICENSE,
    ],
  },
  {
    group: 'Nhà cửa & đời sống',
    axes: ['color', 'size'],
    fields: [
      ['chat_lieu', B], ['kich_thuoc', T], ['dung_tich_ml', T], ['so_mon', T], ['dac_diem', T], ['bep_tuong_thich', T],
      ['lop_chong_dinh', T], ['so_tu_cong_bo', T], ['huong_dan_su_dung', T], ['loai_bao_hanh', T],
    ],
  },
  {
    group: 'Điện tử',
    axes: ['color'],
    // Lazada `warranty_type` và TikTok `100107` đều bắt buộc ở leaf điện tử (research P7).
    fields: [
      ['loai_bao_hanh', B], ['thoi_han_bao_hanh', B], ['model', T], ['tinh_trang', T], ['thiet_bi_tuong_thich', T],
      ['cong_ket_noi', T], ['dung_luong_pin', T], ['bluetooth', T], ['sac_nhanh', T], ['chua_pin', T], ['dien_ap', T],
      ['cong_suat', T], ['chuan_chong_nuoc', T], ['hop_quy', T], ['so_hop_quy', T],
    ],
  },
  {
    group: 'Thực phẩm',
    axes: ['flavor', 'volume'],
    // PL I mục 2: thành phần, hướng dẫn sử dụng, bảo quản; loại thực phẩm quyết định giấy phép (NĐ 15/2018).
    fields: [
      ['loai_thuc_pham', B], ['thanh_phan', B], ['huong_dan_su_dung', B], ['han_su_dung', T], ['cach_bao_quan', T],
      ['loai_bao_bi', T], ['huu_co', T], ['di_ung', T], ...LICENSE,
    ],
  },
  {
    group: 'Mẹ & bé',
    axes: ['size', 'color'],
    fields: [
      ['do_tuoi', B], ['loai_san_pham_be', T], ['chat_lieu', B], ['gioi_tinh_be', T], ['an_toan_vat_lieu', T], ['dung_tich_ml', T],
      ['so_mieng_ta', T], ['loai_ta', T], ...LICENSE, ['hop_quy', T], ['so_hop_quy', T], ['canh_bao', T],
    ],
  },
  {
    group: 'Thể thao',
    axes: ['color', 'size'],
    fields: [
      ['chat_lieu', B], ['tinh_nang', T], ['mon_the_thao', T], ['doi_tuong', T], ['kich_thuoc', T], ['khoi_luong_san_pham', T],
      ['huong_dan_su_dung', T],
    ],
  },
  {
    group: 'Khác',
    axes: ['color'],
    fields: [['chat_lieu', T], ['loai_bao_hanh', T], ['do_tuoi', T], ['huong_dan_su_dung', T], ['canh_bao', T]],
  },
];
