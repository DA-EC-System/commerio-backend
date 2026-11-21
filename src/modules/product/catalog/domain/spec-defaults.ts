// Thư viện thông số (98) và mẫu của 27 danh mục chuẩn (Documents/21 mục 5.5 "Seed", 5.7; 19 §3.2). Nguồn 76 thông số đầu:
// `.claude/issues/thong-so-san-pham/research.md` mục 3 (gọi API thật 68 leaf Lazada, TikTok; gộp `market.md`), ngày 21/11/2026.
// 22 thông số mới và 27 mẫu: `.claude/issues/luong-san-pham/du-lieu-chuan.md` mục 2, 3, 4.2 (#531). Dòng nền tảng do migration
// `*_danh-muc-chuan-du-lieu` ghi (sinh từ file này); test `danh-muc-chuan.test.ts` so DB với hằng.
//
// Ba luật của contract áp lên research:
// - Một thông số mỗi khái niệm: trường cùng tên ở nhiều nhóm là một thông số, lựa chọn là hợp các nhóm (channel ánh xạ
//   mỗi mã sàn từ một thông số; unique `(company, platform, attribute_code)`).
// - `required` chỉ khi luật nhãn đòi cho cả nhóm (NĐ 43/2017 PL I, TT 06/2011/TT-BYT) hoặc mọi sàn có adapter đều đòi;
//   thông số chỉ một sàn đòi (giấy phép TikTok `102872`…) để tuỳ chọn, sàn đó chặn qua `missing`.
// - Thuộc tính đã là trục của nhóm không là thông số của cha: Mỹ phẩm bỏ "Dung tích / Khối lượng", Thực phẩm bỏ
//   "Khối lượng tịnh" (trục `volume`).
import type { DefaultGroup } from './defaults.ts';
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
  // Danh mục chuẩn 27 (#531, `du-lieu-chuan.md` mục 3): 22 thông số mới.
  sel('loai_dam', 'Loại đầm', ['Đầm suông', 'Đầm ôm body', 'Đầm xoè', 'Đầm maxi', 'Đầm sơ mi']),
  sel('loai_do_lot', 'Loại đồ lót', ['Áo ngực', 'Quần lót', 'Đồ ngủ', 'Đồ giữ nhiệt', 'Bộ đồ lót']),
  sel('loai_phu_kien', 'Loại phụ kiện', ['Mũ nón', 'Kính mắt', 'Thắt lưng', 'Khăn', 'Găng tay', 'Kẹp tóc']),
  sel('loai_trang_suc', 'Loại trang sức', ['Nhẫn', 'Dây chuyền', 'Bông tai', 'Vòng tay', 'Lắc chân']),
  sel('loai_dong_ho', 'Loại đồng hồ', ['Cơ', 'Pin (quartz)', 'Điện tử', 'Thông minh']),
  num('khoi_luong_kim_loai', 'Khối lượng kim loại quý', 'chỉ'),
  sel('ram', 'RAM', ['2GB', '3GB', '4GB', '6GB', '8GB', '12GB', '16GB', '32GB']),
  num('kich_thuoc_man_hinh', 'Kích thước màn hình', 'inch'),
  sel('he_dieu_hanh', 'Hệ điều hành', ['Android', 'iOS', 'Windows', 'macOS', 'Khác']),
  sel('cpu', 'Bộ vi xử lý', [
    'Intel Core i3', 'Intel Core i5', 'Intel Core i7', 'Intel Core i9', 'AMD Ryzen 3', 'AMD Ryzen 5', 'AMD Ryzen 7', 'AMD Ryzen 9', 'Apple M',
  ]),
  sel('card_do_hoa', 'Card đồ hoạ', ['Tích hợp', 'NVIDIA GeForce', 'AMD Radeon']),
  sel('do_phan_giai', 'Độ phân giải', ['HD', 'Full HD', '2K', '4K', '8K']),
  sel('cong_nghe_man_hinh', 'Công nghệ màn hình', ['LED', 'QLED', 'OLED', 'Mini LED']),
  sel('loai_ga', 'Loại ga', ['Ga chun', 'Ga phủ', 'Bộ chăn ga gối']),
  multi('loai_toc', 'Loại tóc', ['Tóc thường', 'Tóc dầu', 'Tóc khô', 'Tóc hư tổn', 'Tóc nhuộm']),
  multi('doi_tuong_su_dung', 'Đối tượng sử dụng', ['Người lớn', 'Trẻ em', 'Người cao tuổi', 'Phụ nữ mang thai']),
  sel('loai_thu_cung', 'Loại thú cưng', ['Chó', 'Mèo', 'Cá', 'Chim', 'Thú nhỏ', 'Bò sát']),
  sel('giai_doan_song', 'Giai đoạn sống', ['Con non', 'Trưởng thành', 'Già']),
  text('dong_xe_tuong_thich', 'Dòng xe tương thích'),
  text('isbn', 'ISBN'),
  text('tac_gia', 'Tác giả'),
  text('nha_xuat_ban', 'Nhà xuất bản'),
];

/**
 * Mẫu một danh mục: trục chuẩn theo `platform_kind` (biến thể mặc định, tối đa 2), thuộc tính biến thể được phép thêm
 * (`allowed`, sau trục; 21 mục 5.7), thông số `[code, bắt buộc]` theo thứ tự hiện.
 */
export interface DefaultGroupTemplate {
  readonly group: DefaultGroup;
  readonly axes: readonly PlatformKind[];
  readonly allowed: readonly PlatformKind[];
  readonly fields: readonly (readonly [code: string, required: boolean])[];
}

/** Bắt buộc trước, tuỳ chọn sau (bảng `du-lieu-chuan.md` mục 2: cột BB, TC). */
const tpl = (
  group: DefaultGroup,
  axes: readonly PlatformKind[],
  allowed: readonly PlatformKind[],
  required: readonly string[],
  optional: readonly string[],
): DefaultGroupTemplate => ({
  group,
  axes,
  allowed,
  fields: [...required.map((c) => [c, true] as const), ...optional.map((c) => [c, false] as const)],
});

// Trục mặc định chỉ dùng kind mà leaf Lazada phổ biến của danh mục có sale prop (Lazada không nhận tên tự đặt); `age`,
// `weight` (trừ thú cưng), `version`, `style` chỉ nằm trong `allowed` (du-lieu-chuan.md mục 4.2).
export const DEFAULT_GROUP_TEMPLATES: readonly DefaultGroupTemplate[] = [
  tpl('Thời trang nam', ['color', 'size'], ['style'], ['chat_lieu', 'huong_dan_giat'], [
    'hoa_tiet', 'dang', 'co_ao', 'do_dai_tay', 'kieu_quan', 'cap_quan', 'phong_cach', 'dip_mac', 'tinh_nang', 'mua',
  ]),
  tpl('Thời trang nữ', ['color', 'size'], ['style'], ['chat_lieu', 'huong_dan_giat'], [
    'hoa_tiet', 'dang', 'do_dai_vay', 'co_ao', 'do_dai_tay', 'cap_quan', 'trang_tri', 'phong_cach', 'dip_mac', 'mua', 'loai_dam',
  ]),
  tpl('Đồ lót & đồ ngủ', ['color', 'bra_size'], ['size', 'pack'], ['chat_lieu', 'doi_tuong'], ['loai_do_lot', 'hoa_tiet', 'huong_dan_giat']),
  tpl('Thời trang trẻ em', ['color', 'size'], ['style'], ['chat_lieu', 'gioi_tinh_be'], ['hoa_tiet', 'mua', 'huong_dan_giat', 'an_toan_vat_lieu']),
  tpl('Giày dép', ['color', 'shoe_size'], [], ['chat_lieu', 'doi_tuong'], [
    'kieu_buoc', 'chat_lieu_de', 'co_giay', 'do_cao_got', 'dac_diem', 'be_rong', 'chat_lieu_lot', 'huong_dan_su_dung',
  ]),
  tpl('Túi xách & vali', ['color'], ['size', 'style'], ['chat_lieu'], [
    'loai_tui', 'kieu_khoa', 'loai_da_thuoc', 'co_tui', 'kich_thuoc', 'cach_mang', 'dung_tich_lit', 'doi_tuong',
  ]),
  tpl('Phụ kiện thời trang', ['color'], ['size', 'style'], [], ['chat_lieu', 'doi_tuong', 'phong_cach', 'loai_phu_kien']),
  tpl('Trang sức & đồng hồ', ['color', 'ring_size'], ['style'], ['chat_lieu'], [
    'loai_trang_suc', 'loai_dong_ho', 'chuan_chong_nuoc', 'doi_tuong', 'khoi_luong_kim_loai',
  ]),
  tpl('Điện thoại & máy tính bảng', ['color', 'storage'], ['version'], ['loai_bao_hanh', 'thoi_han_bao_hanh', 'tinh_trang'], [
    'model', 'ram', 'kich_thuoc_man_hinh', 'he_dieu_hanh', 'dung_luong_pin', 'sac_nhanh', 'hop_quy', 'so_hop_quy',
  ]),
  tpl('Máy tính & laptop', ['storage', 'color'], ['version'], ['loai_bao_hanh', 'thoi_han_bao_hanh', 'tinh_trang'], [
    'model', 'cpu', 'ram', 'kich_thuoc_man_hinh', 'card_do_hoa', 'he_dieu_hanh',
  ]),
  tpl('Phụ kiện điện thoại & máy tính', ['color', 'connector'], ['compatible_model', 'length', 'battery_capacity', 'style'], [], [
    'thiet_bi_tuong_thich', 'cong_ket_noi', 'sac_nhanh', 'dung_luong_pin', 'chua_pin', 'cong_suat', 'loai_bao_hanh',
  ]),
  tpl('Âm thanh, TV & máy ảnh', ['color', 'screen_size'], ['version'], ['loai_bao_hanh'], [
    'model', 'bluetooth', 'chuan_chong_nuoc', 'dung_luong_pin', 'do_phan_giai', 'cong_nghe_man_hinh', 'thoi_han_bao_hanh',
  ]),
  tpl('Điện gia dụng', ['color', 'volume'], ['power', 'voltage'], ['loai_bao_hanh', 'dien_ap', 'cong_suat'], [
    'model', 'thoi_han_bao_hanh', 'dung_tich_lit', 'hop_quy', 'so_hop_quy', 'chat_lieu',
  ]),
  tpl('Nhà bếp & phòng ăn', ['color', 'size'], ['volume', 'pack'], ['chat_lieu'], [
    'so_mon', 'bep_tuong_thich', 'lop_chong_dinh', 'dung_tich_ml', 'kich_thuoc', 'so_tu_cong_bo', 'huong_dan_su_dung',
  ]),
  tpl('Nhà cửa & trang trí', ['color', 'bed_size'], ['size', 'style'], ['chat_lieu'], [
    'kich_thuoc', 'phong_cach', 'cong_suat', 'huong_dan_su_dung', 'loai_ga',
  ]),
  tpl('Giặt giũ & vệ sinh nhà cửa', ['volume', 'scent'], ['weight', 'pack'], ['huong_dan_su_dung', 'canh_bao'], [
    'thanh_phan', 'dang_san_pham', 'cong_dung',
  ]),
  tpl(
    'Mỹ phẩm & chăm sóc da',
    ['color', 'volume'],
    ['pack', 'scent'],
    ['loai_giay_phep', 'so_giay_phep', 'thanh_phan', 'cong_dung', 'huong_dan_su_dung', 'canh_bao'],
    ['loai_da', 'han_su_dung', 'dang_san_pham', 'chi_so_chong_nang', 'chi_so_pa', 'hoan_thien', 'ngay_cap', 'noi_cap'],
  ),
  tpl('Chăm sóc cá nhân', ['volume', 'scent'], ['color', 'pack'], ['thanh_phan', 'huong_dan_su_dung'], [
    'loai_da', 'loai_toc', 'cong_dung', 'dang_san_pham', 'han_su_dung', 'loai_giay_phep', 'so_giay_phep',
  ]),
  tpl(
    'Sức khoẻ & thực phẩm chức năng',
    ['pack', 'flavor'],
    ['weight'],
    ['loai_giay_phep', 'so_giay_phep', 'thanh_phan', 'huong_dan_su_dung', 'han_su_dung'],
    ['cong_dung', 'doi_tuong_su_dung', 'dang_san_pham', 'ngay_cap', 'noi_cap', 'canh_bao'],
  ),
  tpl('Mẹ & bé', ['diaper_size', 'pack'], ['color', 'age', 'volume', 'flavor'], ['loai_san_pham_be'], [
    'gioi_tinh_be', 'an_toan_vat_lieu', 'dung_tich_ml', 'loai_ta', 'hop_quy', 'so_hop_quy', 'canh_bao', 'loai_giay_phep', 'so_giay_phep',
  ]),
  tpl('Đồ chơi', ['color', 'size'], ['style', 'age'], ['do_tuoi', 'canh_bao'], ['chat_lieu', 'hop_quy', 'so_hop_quy', 'so_mon', 'dung_luong_pin']),
  tpl(
    'Thực phẩm & đồ uống',
    ['flavor', 'pack'],
    ['weight', 'volume'],
    ['loai_thuc_pham', 'thanh_phan', 'han_su_dung', 'huong_dan_su_dung', 'loai_giay_phep', 'so_giay_phep'],
    ['cach_bao_quan', 'loai_bao_bi', 'huu_co', 'di_ung', 'ngay_cap', 'noi_cap'],
  ),
  tpl('Thú cưng', ['flavor', 'weight'], ['color', 'size'], ['loai_thu_cung'], ['giai_doan_song', 'thanh_phan', 'han_su_dung', 'chat_lieu', 'kich_thuoc']),
  tpl('Thể thao & dã ngoại', ['color', 'size'], ['shoe_size', 'weight'], ['chat_lieu'], [
    'mon_the_thao', 'tinh_nang', 'doi_tuong', 'kich_thuoc', 'khoi_luong_san_pham', 'huong_dan_su_dung',
  ]),
  tpl('Ô tô & xe máy', ['color', 'size'], ['style'], ['dong_xe_tuong_thich'], ['chat_lieu', 'loai_bao_hanh', 'kich_thuoc']),
  tpl('Sách, văn phòng phẩm & dụng cụ', ['color', 'pack'], ['version', 'power'], [], [
    'isbn', 'tac_gia', 'nha_xuat_ban', 'chat_lieu', 'dien_ap', 'cong_suat', 'loai_bao_hanh',
  ]),
  tpl('Khác', ['color', 'size'], ['style', 'pack'], [], ['chat_lieu', 'loai_bao_hanh', 'do_tuoi', 'huong_dan_su_dung', 'canh_bao']),
];
