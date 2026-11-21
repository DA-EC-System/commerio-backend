-- Dữ liệu chuẩn hai tầng (#521, Documents/21 mục 5.6 "Migration", 19 mục 2): ghi dòng nền tảng (12 nhóm, 76 thông số, mẫu,
-- trục, 4 thuộc tính chuẩn), gộp bản sao của từng công ty vào dòng nền tảng, chuyển mọi tham chiếu, xoá bản sao. Dòng công
-- ty không khớp dòng nền tảng nào giữ làm dòng công ty. Ghi `product.tier_merge_remap(kind, old_id, new_id)` cho migration
-- channel (ánh xạ sàn hai tầng) chạy sau, đọc rồi xoá bảng. Sinh từ `catalog/domain/defaults.ts`, `spec-defaults.ts`;
-- test `du-lieu-chung.test.ts` chạy lại phần gộp trên công ty có bản sao kiểu cũ.
-- Khớp: nhóm theo lower(name); thông số theo code (cùng kiểu nhập); lựa chọn theo lower(value) trong thông số; thuộc tính
-- theo platform_kind, không có thì lower(name); giá trị theo lower(value) trong thuộc tính.
CREATE TABLE "product"."tier_merge_remap" (
  "kind" text NOT NULL CHECK ("kind" IN ('group', 'attribute', 'attribute_value', 'spec_field', 'spec_option')),
  "old_id" uuid NOT NULL,
  "new_id" uuid NOT NULL,
  PRIMARY KEY ("kind", "old_id")
)--> statement-breakpoint
REVOKE ALL ON "product"."tier_merge_remap" FROM commerio_app--> statement-breakpoint
-- Khoá ngoại ghép viết tay chặn đổi `attribute_id` của giá trị và `field_id` của lựa chọn giữa chừng: gỡ, cuối file thêm lại.
ALTER TABLE "product"."product_attribute_value_images" DROP CONSTRAINT "pavi_product_fk"--> statement-breakpoint
ALTER TABLE "product"."product_attribute_value_images" DROP CONSTRAINT "pavi_value_fk"--> statement-breakpoint
ALTER TABLE "product"."product_spec_values" DROP CONSTRAINT "psv_option_fk"--> statement-breakpoint
-- 1. Dòng nền tảng (company_id NULL).
INSERT INTO "product"."attributes" ("company_id", "name", "platform_kind", "created_at", "updated_at") VALUES
  (NULL, 'Màu sắc', 'color', now() + 0 * interval '1 millisecond', now()),
  (NULL, 'Kích cỡ', 'size', now() + 1 * interval '1 millisecond', now()),
  (NULL, 'Dung tích', 'volume', now() + 2 * interval '1 millisecond', now()),
  (NULL, 'Hương vị', 'flavor', now() + 3 * interval '1 millisecond', now())--> statement-breakpoint
INSERT INTO "product"."attribute_values" ("company_id", "attribute_id", "value", "code", "created_at", "updated_at")
SELECT NULL, a."id", v."value", v."code", now() + v."pos" * interval '1 millisecond', now()
FROM "product"."attributes" a
JOIN (VALUES
  ('color', 0, 'Đen', 'DEN'), ('color', 1, 'Trắng', 'TRANG'), ('color', 2, 'Đỏ', 'DO'), ('color', 3, 'Xanh dương', 'XANHDU'), ('color', 4, 'Vàng', 'VANG'), ('color', 5, 'Hồng', 'HONG'), ('color', 6, 'Xám', 'XAM'), ('color', 7, 'Be', 'BE'),
  ('size', 0, 'S', 'S'), ('size', 1, 'M', 'M'), ('size', 2, 'L', 'L'), ('size', 3, 'XL', 'XL'), ('size', 4, 'XXL', 'XXL'),
  ('volume', 0, '30ml', '30ML'), ('volume', 1, '50ml', '50ML'), ('volume', 2, '100ml', '100ML'), ('volume', 3, '250ml', '250ML'), ('volume', 4, '500ml', '500ML'), ('volume', 5, '1L', '1L'), ('volume', 6, '100g', '100G'), ('volume', 7, '250g', '250G'), ('volume', 8, '500g', '500G'), ('volume', 9, '1kg', '1KG'),
  ('flavor', 0, 'Nguyên bản', 'NGBAN'), ('flavor', 1, 'Socola', 'SOCOLA'), ('flavor', 2, 'Dâu', 'DAU'), ('flavor', 3, 'Vani', 'VANI'), ('flavor', 4, 'Matcha', 'MATCHA'), ('flavor', 5, 'Cà phê', 'CAPHE')
) AS v("kind", "pos", "value", "code") ON v."kind" = a."platform_kind"
WHERE a."company_id" IS NULL--> statement-breakpoint
INSERT INTO "product"."spec_fields" ("company_id", "code", "name", "input", "unit", "allow_custom", "created_at", "updated_at") VALUES
  (NULL, 'huong_dan_su_dung', 'Hướng dẫn sử dụng, bảo quản', 'text', NULL, false, now() + 0 * interval '1 millisecond', now()),
  (NULL, 'canh_bao', 'Cảnh báo', 'text', NULL, false, now() + 1 * interval '1 millisecond', now()),
  (NULL, 'hop_quy', 'Hợp quy', 'select', NULL, false, now() + 2 * interval '1 millisecond', now()),
  (NULL, 'so_hop_quy', 'Số chứng nhận hợp quy', 'text', NULL, false, now() + 3 * interval '1 millisecond', now()),
  (NULL, 'chat_lieu', 'Chất liệu', 'multiselect', NULL, true, now() + 4 * interval '1 millisecond', now()),
  (NULL, 'hoa_tiet', 'Họa tiết', 'select', NULL, true, now() + 5 * interval '1 millisecond', now()),
  (NULL, 'dang', 'Dáng', 'select', NULL, true, now() + 6 * interval '1 millisecond', now()),
  (NULL, 'co_ao', 'Cổ áo', 'select', NULL, true, now() + 7 * interval '1 millisecond', now()),
  (NULL, 'do_dai_tay', 'Độ dài tay', 'select', NULL, true, now() + 8 * interval '1 millisecond', now()),
  (NULL, 'kieu_quan', 'Kiểu quần', 'select', NULL, true, now() + 9 * interval '1 millisecond', now()),
  (NULL, 'cap_quan', 'Cạp quần', 'select', NULL, true, now() + 10 * interval '1 millisecond', now()),
  (NULL, 'do_dai_vay', 'Độ dài váy/đầm', 'select', NULL, true, now() + 11 * interval '1 millisecond', now()),
  (NULL, 'trang_tri', 'Trang trí', 'multiselect', NULL, true, now() + 12 * interval '1 millisecond', now()),
  (NULL, 'phong_cach', 'Phong cách', 'multiselect', NULL, true, now() + 13 * interval '1 millisecond', now()),
  (NULL, 'dip_mac', 'Dịp mặc', 'multiselect', NULL, true, now() + 14 * interval '1 millisecond', now()),
  (NULL, 'mua', 'Mùa', 'multiselect', NULL, true, now() + 15 * interval '1 millisecond', now()),
  (NULL, 'tinh_nang', 'Tính năng', 'multiselect', NULL, true, now() + 16 * interval '1 millisecond', now()),
  (NULL, 'huong_dan_giat', 'Hướng dẫn giặt', 'multiselect', NULL, true, now() + 17 * interval '1 millisecond', now()),
  (NULL, 'doi_tuong', 'Đối tượng', 'select', NULL, true, now() + 18 * interval '1 millisecond', now()),
  (NULL, 'kieu_buoc', 'Kiểu buộc', 'select', NULL, true, now() + 19 * interval '1 millisecond', now()),
  (NULL, 'chat_lieu_de', 'Chất liệu đế', 'select', NULL, true, now() + 20 * interval '1 millisecond', now()),
  (NULL, 'co_giay', 'Cổ giày', 'select', NULL, true, now() + 21 * interval '1 millisecond', now()),
  (NULL, 'do_cao_got', 'Độ cao gót', 'select', NULL, true, now() + 22 * interval '1 millisecond', now()),
  (NULL, 'dac_diem', 'Đặc điểm', 'multiselect', NULL, true, now() + 23 * interval '1 millisecond', now()),
  (NULL, 'be_rong', 'Bề rộng', 'select', NULL, true, now() + 24 * interval '1 millisecond', now()),
  (NULL, 'chat_lieu_lot', 'Chất liệu lót', 'select', NULL, true, now() + 25 * interval '1 millisecond', now()),
  (NULL, 'loai_tui', 'Loại túi', 'select', NULL, true, now() + 26 * interval '1 millisecond', now()),
  (NULL, 'kieu_khoa', 'Kiểu khoá', 'select', NULL, true, now() + 27 * interval '1 millisecond', now()),
  (NULL, 'loai_da_thuoc', 'Loại da thuộc', 'select', NULL, true, now() + 28 * interval '1 millisecond', now()),
  (NULL, 'co_tui', 'Cỡ túi', 'select', NULL, true, now() + 29 * interval '1 millisecond', now()),
  (NULL, 'kich_thuoc', 'Kích thước', 'text', NULL, false, now() + 30 * interval '1 millisecond', now()),
  (NULL, 'cach_mang', 'Cách mang', 'multiselect', NULL, true, now() + 31 * interval '1 millisecond', now()),
  (NULL, 'dung_tich_lit', 'Dung tích (lít)', 'number', 'L', false, now() + 32 * interval '1 millisecond', now()),
  (NULL, 'dung_tich_ml', 'Dung tích (ml)', 'number', 'ml', false, now() + 33 * interval '1 millisecond', now()),
  (NULL, 'loai_da', 'Loại da', 'multiselect', NULL, true, now() + 34 * interval '1 millisecond', now()),
  (NULL, 'cong_dung', 'Công dụng', 'multiselect', NULL, true, now() + 35 * interval '1 millisecond', now()),
  (NULL, 'dang_san_pham', 'Dạng sản phẩm', 'select', NULL, true, now() + 36 * interval '1 millisecond', now()),
  (NULL, 'han_su_dung', 'Hạn sử dụng', 'select', NULL, true, now() + 37 * interval '1 millisecond', now()),
  (NULL, 'chi_so_chong_nang', 'Chỉ số chống nắng', 'select', NULL, true, now() + 38 * interval '1 millisecond', now()),
  (NULL, 'chi_so_pa', 'Chỉ số PA', 'select', NULL, true, now() + 39 * interval '1 millisecond', now()),
  (NULL, 'hoan_thien', 'Hoàn thiện', 'select', NULL, true, now() + 40 * interval '1 millisecond', now()),
  (NULL, 'thanh_phan', 'Thành phần', 'text', NULL, false, now() + 41 * interval '1 millisecond', now()),
  (NULL, 'loai_giay_phep', 'Loại giấy phép', 'select', NULL, true, now() + 42 * interval '1 millisecond', now()),
  (NULL, 'so_giay_phep', 'Số công bố, đăng ký', 'text', NULL, false, now() + 43 * interval '1 millisecond', now()),
  (NULL, 'ngay_cap', 'Ngày cấp', 'date', NULL, false, now() + 44 * interval '1 millisecond', now()),
  (NULL, 'noi_cap', 'Nơi cấp', 'text', NULL, false, now() + 45 * interval '1 millisecond', now()),
  (NULL, 'so_mon', 'Số món trong bộ', 'number', 'món', false, now() + 46 * interval '1 millisecond', now()),
  (NULL, 'bep_tuong_thich', 'Bếp tương thích', 'multiselect', NULL, true, now() + 47 * interval '1 millisecond', now()),
  (NULL, 'lop_chong_dinh', 'Lớp chống dính', 'select', NULL, true, now() + 48 * interval '1 millisecond', now()),
  (NULL, 'so_tu_cong_bo', 'Số bản tự công bố', 'text', NULL, false, now() + 49 * interval '1 millisecond', now()),
  (NULL, 'loai_bao_hanh', 'Loại bảo hành', 'select', NULL, true, now() + 50 * interval '1 millisecond', now()),
  (NULL, 'thoi_han_bao_hanh', 'Thời hạn bảo hành', 'select', NULL, true, now() + 51 * interval '1 millisecond', now()),
  (NULL, 'model', 'Model', 'text', NULL, false, now() + 52 * interval '1 millisecond', now()),
  (NULL, 'tinh_trang', 'Tình trạng', 'select', NULL, false, now() + 53 * interval '1 millisecond', now()),
  (NULL, 'cong_ket_noi', 'Cổng kết nối', 'multiselect', NULL, true, now() + 54 * interval '1 millisecond', now()),
  (NULL, 'dung_luong_pin', 'Dung lượng pin', 'number', 'mAh', false, now() + 55 * interval '1 millisecond', now()),
  (NULL, 'bluetooth', 'Bluetooth', 'select', NULL, true, now() + 56 * interval '1 millisecond', now()),
  (NULL, 'sac_nhanh', 'Sạc nhanh', 'select', NULL, false, now() + 57 * interval '1 millisecond', now()),
  (NULL, 'chua_pin', 'Chứa pin', 'select', NULL, false, now() + 58 * interval '1 millisecond', now()),
  (NULL, 'thiet_bi_tuong_thich', 'Thiết bị tương thích', 'multiselect', NULL, true, now() + 59 * interval '1 millisecond', now()),
  (NULL, 'dien_ap', 'Điện áp', 'select', NULL, true, now() + 60 * interval '1 millisecond', now()),
  (NULL, 'cong_suat', 'Công suất', 'number', 'W', false, now() + 61 * interval '1 millisecond', now()),
  (NULL, 'chuan_chong_nuoc', 'Chuẩn chống nước', 'select', NULL, true, now() + 62 * interval '1 millisecond', now()),
  (NULL, 'loai_thuc_pham', 'Loại thực phẩm', 'select', NULL, false, now() + 63 * interval '1 millisecond', now()),
  (NULL, 'cach_bao_quan', 'Cách bảo quản', 'select', NULL, true, now() + 64 * interval '1 millisecond', now()),
  (NULL, 'loai_bao_bi', 'Loại bao bì', 'select', NULL, true, now() + 65 * interval '1 millisecond', now()),
  (NULL, 'huu_co', 'Hữu cơ', 'select', NULL, false, now() + 66 * interval '1 millisecond', now()),
  (NULL, 'di_ung', 'Thông tin dị ứng', 'multiselect', NULL, true, now() + 67 * interval '1 millisecond', now()),
  (NULL, 'do_tuoi', 'Độ tuổi phù hợp', 'multiselect', NULL, true, now() + 68 * interval '1 millisecond', now()),
  (NULL, 'loai_san_pham_be', 'Loại sản phẩm', 'select', NULL, true, now() + 69 * interval '1 millisecond', now()),
  (NULL, 'gioi_tinh_be', 'Giới tính bé', 'select', NULL, true, now() + 70 * interval '1 millisecond', now()),
  (NULL, 'an_toan_vat_lieu', 'An toàn vật liệu', 'multiselect', NULL, true, now() + 71 * interval '1 millisecond', now()),
  (NULL, 'so_mieng_ta', 'Số miếng mỗi gói', 'number', 'miếng', false, now() + 72 * interval '1 millisecond', now()),
  (NULL, 'loai_ta', 'Loại tã', 'select', NULL, true, now() + 73 * interval '1 millisecond', now()),
  (NULL, 'mon_the_thao', 'Môn thể thao', 'multiselect', NULL, true, now() + 74 * interval '1 millisecond', now()),
  (NULL, 'khoi_luong_san_pham', 'Khối lượng sản phẩm', 'number', 'kg', false, now() + 75 * interval '1 millisecond', now())--> statement-breakpoint
INSERT INTO "product"."spec_field_options" ("company_id", "field_id", "value", "position", "created_at", "updated_at")
SELECT NULL, f."id", o."value", o."position", now(), now()
FROM "product"."spec_fields" f
JOIN (VALUES
  ('hop_quy', 0, 'Không thuộc diện'),
  ('hop_quy', 1, 'Có dấu CR'),
  ('chat_lieu', 0, 'Cotton'),
  ('chat_lieu', 1, 'Cotton pha (CVC)'),
  ('chat_lieu', 2, 'Polyester'),
  ('chat_lieu', 3, 'Thun co giãn (Spandex)'),
  ('chat_lieu', 4, 'Kaki'),
  ('chat_lieu', 5, 'Denim'),
  ('chat_lieu', 6, 'Lanh'),
  ('chat_lieu', 7, 'Lụa'),
  ('chat_lieu', 8, 'Nỉ'),
  ('chat_lieu', 9, 'Len'),
  ('chat_lieu', 10, 'Nylon'),
  ('chat_lieu', 11, 'Voan'),
  ('chat_lieu', 12, 'Ren'),
  ('chat_lieu', 13, 'Tuyết mưa'),
  ('chat_lieu', 14, 'Đũi'),
  ('chat_lieu', 15, 'Satin'),
  ('chat_lieu', 16, 'Da thật'),
  ('chat_lieu', 17, 'Da tổng hợp (PU)'),
  ('chat_lieu', 18, 'Vải canvas'),
  ('chat_lieu', 19, 'Vải lưới'),
  ('chat_lieu', 20, 'Cao su'),
  ('chat_lieu', 21, 'Nhựa EVA'),
  ('chat_lieu', 22, 'Vải dù'),
  ('chat_lieu', 23, 'Nhựa PVC'),
  ('chat_lieu', 24, 'Thép không gỉ'),
  ('chat_lieu', 25, 'Hợp kim'),
  ('chat_lieu', 26, 'Bạc'),
  ('chat_lieu', 27, 'Vải'),
  ('chat_lieu', 28, 'Nhựa'),
  ('chat_lieu', 29, 'Gỗ'),
  ('chat_lieu', 30, 'Thuỷ tinh'),
  ('chat_lieu', 31, 'Inox'),
  ('chat_lieu', 32, 'Gốm sứ'),
  ('chat_lieu', 33, 'Tre'),
  ('chat_lieu', 34, 'Nhôm'),
  ('chat_lieu', 35, 'Cotton hữu cơ'),
  ('chat_lieu', 36, 'Sợi tre'),
  ('chat_lieu', 37, 'Silicone'),
  ('chat_lieu', 38, 'Nhựa PP'),
  ('chat_lieu', 39, 'PPSU'),
  ('chat_lieu', 40, 'Vải mè (lưới)'),
  ('chat_lieu', 41, 'TPE'),
  ('chat_lieu', 42, 'Giấy'),
  ('chat_lieu', 43, 'Kim loại'),
  ('hoa_tiet', 0, 'Trơn'),
  ('hoa_tiet', 1, 'Kẻ sọc'),
  ('hoa_tiet', 2, 'Kẻ ô (caro)'),
  ('hoa_tiet', 3, 'In chữ'),
  ('hoa_tiet', 4, 'In hình'),
  ('hoa_tiet', 5, 'Hoa'),
  ('hoa_tiet', 6, 'Hoa nhí'),
  ('hoa_tiet', 7, 'Chấm bi'),
  ('hoa_tiet', 8, 'Rằn ri'),
  ('dang', 0, 'Ôm (Slim fit)'),
  ('dang', 1, 'Suông (Regular)'),
  ('dang', 2, 'Rộng (Oversize)'),
  ('dang', 3, 'Chữ A'),
  ('dang', 4, 'Bó (bodycon)'),
  ('dang', 5, 'Xòe'),
  ('co_ao', 0, 'Cổ tròn'),
  ('co_ao', 1, 'Cổ tim'),
  ('co_ao', 2, 'Cổ bẻ (polo)'),
  ('co_ao', 3, 'Cổ sơ mi'),
  ('co_ao', 4, 'Cổ trụ'),
  ('co_ao', 5, 'Có mũ'),
  ('co_ao', 6, 'Cổ vuông'),
  ('co_ao', 7, 'Cổ yếm'),
  ('co_ao', 8, 'Trễ vai'),
  ('do_dai_tay', 0, 'Không tay'),
  ('do_dai_tay', 1, 'Ngắn tay'),
  ('do_dai_tay', 2, 'Tay lửng'),
  ('do_dai_tay', 3, 'Dài tay'),
  ('kieu_quan', 0, 'Ống đứng'),
  ('kieu_quan', 1, 'Ôm (skinny)'),
  ('kieu_quan', 2, 'Ống rộng'),
  ('kieu_quan', 3, 'Ống loe'),
  ('kieu_quan', 4, 'Jogger'),
  ('kieu_quan', 5, 'Cargo'),
  ('cap_quan', 0, 'Cạp thấp'),
  ('cap_quan', 1, 'Cạp thường'),
  ('cap_quan', 2, 'Cạp cao'),
  ('do_dai_vay', 0, 'Mini'),
  ('do_dai_vay', 1, 'Trên gối'),
  ('do_dai_vay', 2, 'Ngang gối'),
  ('do_dai_vay', 3, 'Midi'),
  ('do_dai_vay', 4, 'Maxi'),
  ('trang_tri', 0, 'Không'),
  ('trang_tri', 1, 'Bèo nhún'),
  ('trang_tri', 2, 'Ren'),
  ('trang_tri', 3, 'Nơ'),
  ('trang_tri', 4, 'Thêu'),
  ('trang_tri', 5, 'Đính hạt'),
  ('trang_tri', 6, 'Xếp ly'),
  ('phong_cach', 0, 'Basic'),
  ('phong_cach', 1, 'Công sở'),
  ('phong_cach', 2, 'Đường phố'),
  ('phong_cach', 3, 'Thể thao'),
  ('phong_cach', 4, 'Hàn Quốc'),
  ('phong_cach', 5, 'Vintage'),
  ('phong_cach', 6, 'Dự tiệc'),
  ('phong_cach', 7, 'Tiểu thư'),
  ('phong_cach', 8, 'Thường ngày'),
  ('phong_cach', 9, 'Thanh lịch'),
  ('phong_cach', 10, 'Cổ điển'),
  ('dip_mac', 0, 'Hằng ngày'),
  ('dip_mac', 1, 'Công sở'),
  ('dip_mac', 2, 'Dự tiệc'),
  ('dip_mac', 3, 'Đi biển'),
  ('dip_mac', 4, 'Thể thao'),
  ('dip_mac', 5, 'Lễ tết'),
  ('mua', 0, 'Xuân'),
  ('mua', 1, 'Hè'),
  ('mua', 2, 'Thu'),
  ('mua', 3, 'Đông'),
  ('mua', 4, 'Bốn mùa'),
  ('tinh_nang', 0, 'Co giãn'),
  ('tinh_nang', 1, 'Khô nhanh'),
  ('tinh_nang', 2, 'Thấm hút mồ hôi'),
  ('tinh_nang', 3, 'Chống tia UV'),
  ('tinh_nang', 4, 'Thoáng khí'),
  ('tinh_nang', 5, 'Chống trượt'),
  ('tinh_nang', 6, 'Chống nước'),
  ('huong_dan_giat', 0, 'Giặt máy'),
  ('huong_dan_giat', 1, 'Giặt tay'),
  ('huong_dan_giat', 2, 'Giặt nước lạnh'),
  ('huong_dan_giat', 3, 'Không giặt khô'),
  ('huong_dan_giat', 4, 'Không tẩy'),
  ('huong_dan_giat', 5, 'Là nhiệt độ thấp'),
  ('doi_tuong', 0, 'Nam'),
  ('doi_tuong', 1, 'Nữ'),
  ('doi_tuong', 2, 'Unisex'),
  ('kieu_buoc', 0, 'Dây buộc'),
  ('kieu_buoc', 1, 'Xỏ (slip-on)'),
  ('kieu_buoc', 2, 'Khoá dán'),
  ('kieu_buoc', 3, 'Khoá kéo'),
  ('kieu_buoc', 4, 'Quai'),
  ('chat_lieu_de', 0, 'Cao su'),
  ('chat_lieu_de', 1, 'EVA'),
  ('chat_lieu_de', 2, 'TPU'),
  ('chat_lieu_de', 3, 'TPR'),
  ('chat_lieu_de', 4, 'PVC'),
  ('co_giay', 0, 'Cổ thấp'),
  ('co_giay', 1, 'Cổ vừa'),
  ('co_giay', 2, 'Cổ cao'),
  ('do_cao_got', 0, 'Không gót'),
  ('do_cao_got', 1, 'Dưới 3 cm'),
  ('do_cao_got', 2, '3–5 cm'),
  ('do_cao_got', 3, '5–8 cm'),
  ('do_cao_got', 4, 'Trên 8 cm'),
  ('dac_diem', 0, 'Nhẹ'),
  ('dac_diem', 1, 'Thoáng khí'),
  ('dac_diem', 2, 'Chống trượt'),
  ('dac_diem', 3, 'Chống nước'),
  ('dac_diem', 4, 'Êm chân'),
  ('dac_diem', 5, 'Chống trộm'),
  ('dac_diem', 6, 'Nhiều ngăn'),
  ('dac_diem', 7, 'Có ngăn laptop'),
  ('dac_diem', 8, 'Cổng USB'),
  ('dac_diem', 9, 'Chống dính'),
  ('dac_diem', 10, 'Dùng được lò vi sóng'),
  ('dac_diem', 11, 'Dùng được máy rửa bát'),
  ('dac_diem', 12, 'Có nắp'),
  ('dac_diem', 13, 'Xếp chồng được'),
  ('be_rong', 0, 'Hẹp'),
  ('be_rong', 1, 'Thường'),
  ('be_rong', 2, 'Rộng'),
  ('chat_lieu_lot', 0, 'Da'),
  ('chat_lieu_lot', 1, 'Vải lưới'),
  ('chat_lieu_lot', 2, 'Cotton'),
  ('chat_lieu_lot', 3, 'Nỉ'),
  ('loai_tui', 0, 'Túi đeo chéo'),
  ('loai_tui', 1, 'Túi đeo vai'),
  ('loai_tui', 2, 'Túi xách tay'),
  ('loai_tui', 3, 'Túi tote'),
  ('loai_tui', 4, 'Ba lô'),
  ('loai_tui', 5, 'Ví dài'),
  ('loai_tui', 6, 'Ví ngắn'),
  ('loai_tui', 7, 'Ví đựng thẻ'),
  ('kieu_khoa', 0, 'Khoá kéo'),
  ('kieu_khoa', 1, 'Nút bấm'),
  ('kieu_khoa', 2, 'Nam châm'),
  ('kieu_khoa', 3, 'Khoá gài'),
  ('kieu_khoa', 4, 'Dây rút'),
  ('loai_da_thuoc', 0, 'Da bò'),
  ('loai_da_thuoc', 1, 'Da cừu'),
  ('loai_da_thuoc', 2, 'Da dê'),
  ('loai_da_thuoc', 3, 'Không phải da'),
  ('co_tui', 0, 'Mini'),
  ('co_tui', 1, 'Nhỏ'),
  ('co_tui', 2, 'Vừa'),
  ('co_tui', 3, 'Lớn'),
  ('cach_mang', 0, 'Quai xách'),
  ('cach_mang', 1, 'Dây đeo vai'),
  ('cach_mang', 2, 'Dây đeo chéo'),
  ('cach_mang', 3, 'Quai ba lô'),
  ('cach_mang', 4, 'Dây tháo rời'),
  ('loai_da', 0, 'Mọi loại da'),
  ('loai_da', 1, 'Da dầu'),
  ('loai_da', 2, 'Da khô'),
  ('loai_da', 3, 'Da hỗn hợp'),
  ('loai_da', 4, 'Da nhạy cảm'),
  ('loai_da', 5, 'Da mụn'),
  ('loai_da', 6, 'Da thường'),
  ('cong_dung', 0, 'Dưỡng ẩm'),
  ('cong_dung', 1, 'Làm sáng'),
  ('cong_dung', 2, 'Chống lão hoá'),
  ('cong_dung', 3, 'Kiềm dầu'),
  ('cong_dung', 4, 'Trị mụn'),
  ('cong_dung', 5, 'Làm dịu'),
  ('cong_dung', 6, 'Chống nắng'),
  ('dang_san_pham', 0, 'Kem'),
  ('dang_san_pham', 1, 'Gel'),
  ('dang_san_pham', 2, 'Lotion'),
  ('dang_san_pham', 3, 'Serum'),
  ('dang_san_pham', 4, 'Dầu'),
  ('dang_san_pham', 5, 'Xịt'),
  ('dang_san_pham', 6, 'Thỏi'),
  ('dang_san_pham', 7, 'Lỏng'),
  ('han_su_dung', 0, '3 tháng'),
  ('han_su_dung', 1, '6 tháng'),
  ('han_su_dung', 2, '9 tháng'),
  ('han_su_dung', 3, '12 tháng'),
  ('han_su_dung', 4, '18 tháng'),
  ('han_su_dung', 5, '24 tháng'),
  ('han_su_dung', 6, '36 tháng'),
  ('chi_so_chong_nang', 0, 'SPF 15'),
  ('chi_so_chong_nang', 1, 'SPF 30'),
  ('chi_so_chong_nang', 2, 'SPF 50'),
  ('chi_so_chong_nang', 3, 'SPF 50+'),
  ('chi_so_pa', 0, 'PA+'),
  ('chi_so_pa', 1, 'PA++'),
  ('chi_so_pa', 2, 'PA+++'),
  ('chi_so_pa', 3, 'PA++++'),
  ('hoan_thien', 0, 'Lì (matte)'),
  ('hoan_thien', 1, 'Bóng'),
  ('hoan_thien', 2, 'Satin'),
  ('hoan_thien', 3, 'Tự nhiên'),
  ('loai_giay_phep', 0, 'Phiếu công bố sản phẩm mỹ phẩm'),
  ('loai_giay_phep', 1, 'Bản tự công bố sản phẩm'),
  ('loai_giay_phep', 2, 'Giấy tiếp nhận đăng ký bản công bố'),
  ('loai_giay_phep', 3, 'Giấy công bố tiêu chuẩn'),
  ('loai_giay_phep', 4, 'Giấy công bố hợp quy'),
  ('loai_giay_phep', 5, 'Giấy chứng nhận cơ sở đủ điều kiện ATTP'),
  ('bep_tuong_thich', 0, 'Bếp từ'),
  ('bep_tuong_thich', 1, 'Bếp gas'),
  ('bep_tuong_thich', 2, 'Bếp hồng ngoại'),
  ('bep_tuong_thich', 3, 'Bếp điện'),
  ('lop_chong_dinh', 0, 'Ceramic'),
  ('lop_chong_dinh', 1, 'PTFE (Teflon)'),
  ('lop_chong_dinh', 2, 'Men'),
  ('lop_chong_dinh', 3, 'Anod cứng'),
  ('lop_chong_dinh', 4, 'Không phủ'),
  ('loai_bao_hanh', 0, 'Bảo hành nhà sản xuất'),
  ('loai_bao_hanh', 1, 'Bảo hành người bán'),
  ('loai_bao_hanh', 2, 'Bảo hành quốc tế'),
  ('loai_bao_hanh', 3, 'Không bảo hành'),
  ('thoi_han_bao_hanh', 0, '1 tháng'),
  ('thoi_han_bao_hanh', 1, '3 tháng'),
  ('thoi_han_bao_hanh', 2, '6 tháng'),
  ('thoi_han_bao_hanh', 3, '12 tháng'),
  ('thoi_han_bao_hanh', 4, '24 tháng'),
  ('tinh_trang', 0, 'Mới'),
  ('tinh_trang', 1, 'Tân trang'),
  ('tinh_trang', 2, 'Đã qua sử dụng'),
  ('cong_ket_noi', 0, 'USB-C'),
  ('cong_ket_noi', 1, 'Lightning'),
  ('cong_ket_noi', 2, 'Micro USB'),
  ('cong_ket_noi', 3, 'USB-A'),
  ('cong_ket_noi', 4, 'Jack 3.5 mm'),
  ('bluetooth', 0, '5.0'),
  ('bluetooth', 1, '5.1'),
  ('bluetooth', 2, '5.2'),
  ('bluetooth', 3, '5.3'),
  ('bluetooth', 4, '5.4'),
  ('sac_nhanh', 0, 'Có'),
  ('sac_nhanh', 1, 'Không'),
  ('chua_pin', 0, 'Không có pin'),
  ('chua_pin', 1, 'Pin tích hợp'),
  ('chua_pin', 2, 'Pin rời'),
  ('thiet_bi_tuong_thich', 0, 'Apple'),
  ('thiet_bi_tuong_thich', 1, 'Samsung'),
  ('thiet_bi_tuong_thich', 2, 'Xiaomi'),
  ('thiet_bi_tuong_thich', 3, 'Oppo'),
  ('thiet_bi_tuong_thich', 4, 'Laptop'),
  ('dien_ap', 0, '5V (USB)'),
  ('dien_ap', 1, '12V'),
  ('dien_ap', 2, '220V~50Hz'),
  ('dien_ap', 3, 'Dùng pin'),
  ('chuan_chong_nuoc', 0, 'Không'),
  ('chuan_chong_nuoc', 1, 'IPX4'),
  ('chuan_chong_nuoc', 2, 'IPX5'),
  ('chuan_chong_nuoc', 3, 'IPX7'),
  ('chuan_chong_nuoc', 4, 'IP67'),
  ('chuan_chong_nuoc', 5, 'IP68'),
  ('loai_thuc_pham', 0, 'Thực phẩm thường'),
  ('loai_thuc_pham', 1, 'Thực phẩm bảo vệ sức khoẻ'),
  ('loai_thuc_pham', 2, 'Thực phẩm bổ sung'),
  ('loai_thuc_pham', 3, 'Đồ uống'),
  ('loai_thuc_pham', 4, 'Rượu bia'),
  ('cach_bao_quan', 0, 'Nhiệt độ phòng'),
  ('cach_bao_quan', 1, 'Ngăn mát'),
  ('cach_bao_quan', 2, 'Ngăn đông'),
  ('cach_bao_quan', 3, 'Nơi khô ráo'),
  ('loai_bao_bi', 0, 'Túi'),
  ('loai_bao_bi', 1, 'Hộp'),
  ('loai_bao_bi', 2, 'Lon'),
  ('loai_bao_bi', 3, 'Chai'),
  ('loai_bao_bi', 4, 'Hũ'),
  ('loai_bao_bi', 5, 'Thùng'),
  ('huu_co', 0, 'Có'),
  ('huu_co', 1, 'Không'),
  ('di_ung', 0, 'Sữa'),
  ('di_ung', 1, 'Trứng'),
  ('di_ung', 2, 'Cá'),
  ('di_ung', 3, 'Tôm cua'),
  ('di_ung', 4, 'Đậu phộng'),
  ('di_ung', 5, 'Các loại hạt'),
  ('di_ung', 6, 'Đậu nành'),
  ('di_ung', 7, 'Lúa mì (gluten)'),
  ('di_ung', 8, 'Mè'),
  ('do_tuoi', 0, '0–3 tháng'),
  ('do_tuoi', 1, '3–6 tháng'),
  ('do_tuoi', 2, '6–12 tháng'),
  ('do_tuoi', 3, '1–2 tuổi'),
  ('do_tuoi', 4, '2–3 tuổi'),
  ('do_tuoi', 5, '3–6 tuổi'),
  ('do_tuoi', 6, '3+'),
  ('do_tuoi', 7, '6+'),
  ('do_tuoi', 8, '12+'),
  ('do_tuoi', 9, 'Người lớn'),
  ('loai_san_pham_be', 0, 'Quần áo'),
  ('loai_san_pham_be', 1, 'Tã bỉm'),
  ('loai_san_pham_be', 2, 'Bình sữa & đồ ăn dặm'),
  ('loai_san_pham_be', 3, 'Đồ chơi'),
  ('loai_san_pham_be', 4, 'Sữa & dinh dưỡng'),
  ('loai_san_pham_be', 5, 'Đồ dùng khác'),
  ('gioi_tinh_be', 0, 'Bé trai'),
  ('gioi_tinh_be', 1, 'Bé gái'),
  ('gioi_tinh_be', 2, 'Unisex'),
  ('an_toan_vat_lieu', 0, 'Không BPA'),
  ('an_toan_vat_lieu', 1, 'Không phthalate'),
  ('an_toan_vat_lieu', 2, 'Không chất độc hại'),
  ('loai_ta', 0, 'Tã dán'),
  ('loai_ta', 1, 'Tã quần'),
  ('loai_ta', 2, 'Tã bơi'),
  ('mon_the_thao', 0, 'Chạy bộ'),
  ('mon_the_thao', 1, 'Gym'),
  ('mon_the_thao', 2, 'Yoga'),
  ('mon_the_thao', 3, 'Bóng đá'),
  ('mon_the_thao', 4, 'Cầu lông'),
  ('mon_the_thao', 5, 'Tennis'),
  ('mon_the_thao', 6, 'Bơi'),
  ('mon_the_thao', 7, 'Đạp xe')
) AS o("code", "position", "value") ON o."code" = f."code"
WHERE f."company_id" IS NULL--> statement-breakpoint
INSERT INTO "product"."product_groups" ("company_id", "name", "axis1_attribute_id", "axis2_attribute_id", "created_at", "updated_at")
SELECT NULL, g."name",
  (SELECT a."id" FROM "product"."attributes" a WHERE a."company_id" IS NULL AND a."platform_kind" = g."axis1"),
  (SELECT a."id" FROM "product"."attributes" a WHERE a."company_id" IS NULL AND a."platform_kind" = g."axis2"),
  now() + g."pos" * interval '1 millisecond', now()
FROM (VALUES
  (0, 'Thời trang nam', 'color', 'size'),
  (1, 'Thời trang nữ', 'color', 'size'),
  (2, 'Giày dép', 'color', 'size'),
  (3, 'Túi ví', 'color', NULL),
  (4, 'Phụ kiện', 'color', NULL),
  (5, 'Mỹ phẩm & làm đẹp', 'color', 'volume'),
  (6, 'Nhà cửa & đời sống', 'color', 'size'),
  (7, 'Điện tử', 'color', NULL),
  (8, 'Thực phẩm', 'flavor', 'volume'),
  (9, 'Mẹ & bé', 'size', 'color'),
  (10, 'Thể thao', 'color', 'size'),
  (11, 'Khác', 'color', NULL)
) AS g("pos", "name", "axis1", "axis2")--> statement-breakpoint
INSERT INTO "product"."group_spec_fields" ("company_id", "group_id", "field_id", "required", "position")
SELECT NULL, g."id", f."id", t."required", t."position"
FROM (VALUES
  ('Thời trang nam', 'chat_lieu', true, 0),
  ('Thời trang nam', 'hoa_tiet', false, 1),
  ('Thời trang nam', 'dang', false, 2),
  ('Thời trang nam', 'co_ao', false, 3),
  ('Thời trang nam', 'do_dai_tay', false, 4),
  ('Thời trang nam', 'kieu_quan', false, 5),
  ('Thời trang nam', 'cap_quan', false, 6),
  ('Thời trang nam', 'phong_cach', false, 7),
  ('Thời trang nam', 'dip_mac', false, 8),
  ('Thời trang nam', 'tinh_nang', false, 9),
  ('Thời trang nam', 'mua', false, 10),
  ('Thời trang nam', 'huong_dan_giat', true, 11),
  ('Thời trang nữ', 'chat_lieu', true, 0),
  ('Thời trang nữ', 'huong_dan_giat', true, 1),
  ('Thời trang nữ', 'hoa_tiet', false, 2),
  ('Thời trang nữ', 'dang', false, 3),
  ('Thời trang nữ', 'do_dai_vay', false, 4),
  ('Thời trang nữ', 'co_ao', false, 5),
  ('Thời trang nữ', 'do_dai_tay', false, 6),
  ('Thời trang nữ', 'cap_quan', false, 7),
  ('Thời trang nữ', 'trang_tri', false, 8),
  ('Thời trang nữ', 'phong_cach', false, 9),
  ('Thời trang nữ', 'dip_mac', false, 10),
  ('Thời trang nữ', 'mua', false, 11),
  ('Giày dép', 'chat_lieu', true, 0),
  ('Giày dép', 'doi_tuong', false, 1),
  ('Giày dép', 'kieu_buoc', false, 2),
  ('Giày dép', 'chat_lieu_de', false, 3),
  ('Giày dép', 'co_giay', false, 4),
  ('Giày dép', 'do_cao_got', false, 5),
  ('Giày dép', 'dac_diem', false, 6),
  ('Giày dép', 'be_rong', false, 7),
  ('Giày dép', 'chat_lieu_lot', false, 8),
  ('Giày dép', 'huong_dan_su_dung', false, 9),
  ('Túi ví', 'chat_lieu', true, 0),
  ('Túi ví', 'loai_tui', false, 1),
  ('Túi ví', 'kieu_khoa', false, 2),
  ('Túi ví', 'loai_da_thuoc', false, 3),
  ('Túi ví', 'co_tui', false, 4),
  ('Túi ví', 'kich_thuoc', false, 5),
  ('Túi ví', 'cach_mang', false, 6),
  ('Túi ví', 'dung_tich_lit', false, 7),
  ('Túi ví', 'dac_diem', false, 8),
  ('Túi ví', 'doi_tuong', false, 9),
  ('Phụ kiện', 'chat_lieu', false, 0),
  ('Phụ kiện', 'doi_tuong', false, 1),
  ('Phụ kiện', 'phong_cach', false, 2),
  ('Mỹ phẩm & làm đẹp', 'thanh_phan', true, 0),
  ('Mỹ phẩm & làm đẹp', 'huong_dan_su_dung', true, 1),
  ('Mỹ phẩm & làm đẹp', 'canh_bao', true, 2),
  ('Mỹ phẩm & làm đẹp', 'cong_dung', true, 3),
  ('Mỹ phẩm & làm đẹp', 'loai_da', false, 4),
  ('Mỹ phẩm & làm đẹp', 'han_su_dung', false, 5),
  ('Mỹ phẩm & làm đẹp', 'dang_san_pham', false, 6),
  ('Mỹ phẩm & làm đẹp', 'chi_so_chong_nang', false, 7),
  ('Mỹ phẩm & làm đẹp', 'chi_so_pa', false, 8),
  ('Mỹ phẩm & làm đẹp', 'hoan_thien', false, 9),
  ('Mỹ phẩm & làm đẹp', 'loai_giay_phep', false, 10),
  ('Mỹ phẩm & làm đẹp', 'so_giay_phep', false, 11),
  ('Mỹ phẩm & làm đẹp', 'ngay_cap', false, 12),
  ('Mỹ phẩm & làm đẹp', 'noi_cap', false, 13),
  ('Nhà cửa & đời sống', 'chat_lieu', true, 0),
  ('Nhà cửa & đời sống', 'kich_thuoc', false, 1),
  ('Nhà cửa & đời sống', 'dung_tich_ml', false, 2),
  ('Nhà cửa & đời sống', 'so_mon', false, 3),
  ('Nhà cửa & đời sống', 'dac_diem', false, 4),
  ('Nhà cửa & đời sống', 'bep_tuong_thich', false, 5),
  ('Nhà cửa & đời sống', 'lop_chong_dinh', false, 6),
  ('Nhà cửa & đời sống', 'so_tu_cong_bo', false, 7),
  ('Nhà cửa & đời sống', 'huong_dan_su_dung', false, 8),
  ('Nhà cửa & đời sống', 'loai_bao_hanh', false, 9),
  ('Điện tử', 'loai_bao_hanh', true, 0),
  ('Điện tử', 'thoi_han_bao_hanh', true, 1),
  ('Điện tử', 'model', false, 2),
  ('Điện tử', 'tinh_trang', false, 3),
  ('Điện tử', 'thiet_bi_tuong_thich', false, 4),
  ('Điện tử', 'cong_ket_noi', false, 5),
  ('Điện tử', 'dung_luong_pin', false, 6),
  ('Điện tử', 'bluetooth', false, 7),
  ('Điện tử', 'sac_nhanh', false, 8),
  ('Điện tử', 'chua_pin', false, 9),
  ('Điện tử', 'dien_ap', false, 10),
  ('Điện tử', 'cong_suat', false, 11),
  ('Điện tử', 'chuan_chong_nuoc', false, 12),
  ('Điện tử', 'hop_quy', false, 13),
  ('Điện tử', 'so_hop_quy', false, 14),
  ('Thực phẩm', 'loai_thuc_pham', true, 0),
  ('Thực phẩm', 'thanh_phan', true, 1),
  ('Thực phẩm', 'huong_dan_su_dung', true, 2),
  ('Thực phẩm', 'han_su_dung', false, 3),
  ('Thực phẩm', 'cach_bao_quan', false, 4),
  ('Thực phẩm', 'loai_bao_bi', false, 5),
  ('Thực phẩm', 'huu_co', false, 6),
  ('Thực phẩm', 'di_ung', false, 7),
  ('Thực phẩm', 'loai_giay_phep', false, 8),
  ('Thực phẩm', 'so_giay_phep', false, 9),
  ('Thực phẩm', 'ngay_cap', false, 10),
  ('Thực phẩm', 'noi_cap', false, 11),
  ('Mẹ & bé', 'do_tuoi', true, 0),
  ('Mẹ & bé', 'loai_san_pham_be', false, 1),
  ('Mẹ & bé', 'chat_lieu', true, 2),
  ('Mẹ & bé', 'gioi_tinh_be', false, 3),
  ('Mẹ & bé', 'an_toan_vat_lieu', false, 4),
  ('Mẹ & bé', 'dung_tich_ml', false, 5),
  ('Mẹ & bé', 'so_mieng_ta', false, 6),
  ('Mẹ & bé', 'loai_ta', false, 7),
  ('Mẹ & bé', 'loai_giay_phep', false, 8),
  ('Mẹ & bé', 'so_giay_phep', false, 9),
  ('Mẹ & bé', 'ngay_cap', false, 10),
  ('Mẹ & bé', 'noi_cap', false, 11),
  ('Mẹ & bé', 'hop_quy', false, 12),
  ('Mẹ & bé', 'so_hop_quy', false, 13),
  ('Mẹ & bé', 'canh_bao', false, 14),
  ('Thể thao', 'chat_lieu', true, 0),
  ('Thể thao', 'tinh_nang', false, 1),
  ('Thể thao', 'mon_the_thao', false, 2),
  ('Thể thao', 'doi_tuong', false, 3),
  ('Thể thao', 'kich_thuoc', false, 4),
  ('Thể thao', 'khoi_luong_san_pham', false, 5),
  ('Thể thao', 'huong_dan_su_dung', false, 6),
  ('Khác', 'chat_lieu', false, 0),
  ('Khác', 'loai_bao_hanh', false, 1),
  ('Khác', 'do_tuoi', false, 2),
  ('Khác', 'huong_dan_su_dung', false, 3),
  ('Khác', 'canh_bao', false, 4)
) AS t("group", "code", "required", "position")
JOIN "product"."product_groups" g ON g."company_id" IS NULL AND g."name" = t."group"
JOIN "product"."spec_fields" f ON f."company_id" IS NULL AND f."code" = t."code"--> statement-breakpoint
-- 2. Khớp bản sao của từng công ty sang dòng nền tảng.
INSERT INTO "product"."tier_merge_remap"
SELECT DISTINCT ON (a."id") 'attribute', a."id", p."id"
FROM "product"."attributes" a
JOIN "product"."attributes" p ON p."company_id" IS NULL
  AND (p."platform_kind" = a."platform_kind" OR (a."platform_kind" IS NULL AND lower(trim(a."name")) = lower(p."name")))
WHERE a."company_id" IS NOT NULL
ORDER BY a."id", (p."platform_kind" = a."platform_kind") DESC NULLS LAST--> statement-breakpoint
INSERT INTO "product"."tier_merge_remap"
SELECT 'attribute_value', v."id", pv."id"
FROM "product"."attribute_values" v
JOIN "product"."tier_merge_remap" r ON r."kind" = 'attribute' AND r."old_id" = v."attribute_id"
JOIN "product"."attribute_values" pv ON pv."company_id" IS NULL AND pv."attribute_id" = r."new_id" AND lower(pv."value") = lower(trim(v."value"))
WHERE v."company_id" IS NOT NULL--> statement-breakpoint
-- Giá trị không khớp: hai thuộc tính của một công ty cùng gộp vào một thuộc tính nền tảng có thể trùng chữ; giữ dòng cũ nhất.
INSERT INTO "product"."tier_merge_remap"
SELECT 'attribute_value', k."id", k."keeper"
FROM (
  SELECT v."id", first_value(v."id") OVER (PARTITION BY v."company_id", r."new_id", lower(trim(v."value")) ORDER BY v."created_at", v."id") AS "keeper"
  FROM "product"."attribute_values" v
  JOIN "product"."tier_merge_remap" r ON r."kind" = 'attribute' AND r."old_id" = v."attribute_id"
  WHERE NOT EXISTS (SELECT 1 FROM "product"."tier_merge_remap" x WHERE x."kind" = 'attribute_value' AND x."old_id" = v."id")
) k
WHERE k."id" <> k."keeper"--> statement-breakpoint
INSERT INTO "product"."tier_merge_remap"
SELECT 'spec_field', f."id", p."id"
FROM "product"."spec_fields" f
JOIN "product"."spec_fields" p ON p."company_id" IS NULL AND p."code" = f."code" AND p."input" = f."input"
WHERE f."company_id" IS NOT NULL--> statement-breakpoint
INSERT INTO "product"."tier_merge_remap"
SELECT 'spec_option', o."id", po."id"
FROM "product"."spec_field_options" o
JOIN "product"."tier_merge_remap" r ON r."kind" = 'spec_field' AND r."old_id" = o."field_id"
JOIN "product"."spec_field_options" po ON po."company_id" IS NULL AND po."field_id" = r."new_id" AND lower(po."value") = lower(trim(o."value"))
WHERE o."company_id" IS NOT NULL--> statement-breakpoint
INSERT INTO "product"."tier_merge_remap"
SELECT 'group', g."id", p."id"
FROM "product"."product_groups" g
JOIN "product"."product_groups" p ON p."company_id" IS NULL AND lower(p."name") = lower(trim(g."name"))
WHERE g."company_id" IS NOT NULL--> statement-breakpoint
-- 3. Chuyển tham chiếu. Giá trị, lựa chọn không khớp của thuộc tính, thông số đã gộp: thành dòng công ty của dòng nền tảng.
WITH "dup" AS (
  SELECT v."id", r."new_id", row_number() OVER (PARTITION BY v."company_id", r."new_id", v."code" ORDER BY v."created_at", v."id") AS "n"
  FROM "product"."attribute_values" v
  JOIN "product"."tier_merge_remap" r ON r."kind" = 'attribute' AND r."old_id" = v."attribute_id"
  WHERE NOT EXISTS (SELECT 1 FROM "product"."tier_merge_remap" x WHERE x."kind" = 'attribute_value' AND x."old_id" = v."id")
)
UPDATE "product"."attribute_values" v
SET "attribute_id" = d."new_id",
  "code" = CASE WHEN d."n" = 1 THEN v."code" ELSE left(v."code", 4) || d."n"::text END,
  "version" = v."version" + 1, "updated_at" = now()
FROM "dup" d WHERE d."id" = v."id"--> statement-breakpoint
UPDATE "product"."spec_field_options" o SET "field_id" = r."new_id", "version" = o."version" + 1, "updated_at" = now()
FROM "product"."tier_merge_remap" r
WHERE r."kind" = 'spec_field' AND r."old_id" = o."field_id"
  AND NOT EXISTS (SELECT 1 FROM "product"."tier_merge_remap" x WHERE x."kind" = 'spec_option' AND x."old_id" = o."id")--> statement-breakpoint
UPDATE "product"."variant_attribute_values" t SET "attribute_value_id" = r."new_id"
FROM "product"."tier_merge_remap" r WHERE r."kind" = 'attribute_value' AND r."old_id" = t."attribute_value_id"--> statement-breakpoint
UPDATE "product"."product_attribute_value_images" t SET "attribute_value_id" = r."new_id"
FROM "product"."tier_merge_remap" r WHERE r."kind" = 'attribute_value' AND r."old_id" = t."attribute_value_id"--> statement-breakpoint
UPDATE "product"."product_attribute_value_images" t SET "attribute_id" = r."new_id"
FROM "product"."tier_merge_remap" r WHERE r."kind" = 'attribute' AND r."old_id" = t."attribute_id"--> statement-breakpoint
UPDATE "product"."products" t SET "image_attribute_id" = r."new_id"
FROM "product"."tier_merge_remap" r WHERE r."kind" = 'attribute' AND r."old_id" = t."image_attribute_id"--> statement-breakpoint
UPDATE "product"."product_groups" t SET "axis1_attribute_id" = r."new_id"
FROM "product"."tier_merge_remap" r WHERE r."kind" = 'attribute' AND r."old_id" = t."axis1_attribute_id"--> statement-breakpoint
UPDATE "product"."product_groups" t SET "axis2_attribute_id" = r."new_id"
FROM "product"."tier_merge_remap" r WHERE r."kind" = 'attribute' AND r."old_id" = t."axis2_attribute_id"--> statement-breakpoint
UPDATE "product"."product_spec_values" t SET "option_id" = r."new_id"
FROM "product"."tier_merge_remap" r WHERE r."kind" = 'spec_option' AND r."old_id" = t."option_id"--> statement-breakpoint
UPDATE "product"."product_spec_values" t SET "field_id" = r."new_id"
FROM "product"."tier_merge_remap" r WHERE r."kind" = 'spec_field' AND r."old_id" = t."field_id"--> statement-breakpoint
UPDATE "product"."group_spec_fields" t SET "field_id" = r."new_id"
FROM "product"."tier_merge_remap" r WHERE r."kind" = 'spec_field' AND r."old_id" = t."field_id"--> statement-breakpoint
-- Dòng mẫu công ty tự thêm vào nhóm bản sao (thông số ngoài mẫu chuẩn) thành dòng công ty của nhóm nền tảng, đứng sau dòng chuẩn.
UPDATE "product"."group_spec_fields" t SET "group_id" = r."new_id"
FROM "product"."tier_merge_remap" r
WHERE r."kind" = 'group' AND r."old_id" = t."group_id"
  AND NOT EXISTS (SELECT 1 FROM "product"."group_spec_fields" s WHERE s."company_id" IS NULL AND s."group_id" = r."new_id" AND s."field_id" = t."field_id")--> statement-breakpoint
-- Gợi ý của nhóm bản sao sang cài đặt của công ty trên nhóm nền tảng.
INSERT INTO "product"."company_group_settings" ("company_id", "group_id", "margin_coefficient", "price_rounding", "reorder_lead_days", "reorder_safety_qty", "reorder_default_qty")
SELECT DISTINCT ON (g."company_id", r."new_id") g."company_id", r."new_id", g."margin_coefficient", g."price_rounding", g."reorder_lead_days", g."reorder_safety_qty", g."reorder_default_qty"
FROM "product"."product_groups" g
JOIN "product"."tier_merge_remap" r ON r."kind" = 'group' AND r."old_id" = g."id"
WHERE COALESCE(g."margin_coefficient"::text, g."price_rounding"::text, g."reorder_lead_days"::text, g."reorder_safety_qty"::text, g."reorder_default_qty"::text) IS NOT NULL
ORDER BY g."company_id", r."new_id", g."updated_at" DESC--> statement-breakpoint
UPDATE "product"."products" t SET "group_id" = r."new_id"
FROM "product"."tier_merge_remap" r WHERE r."kind" = 'group' AND r."old_id" = t."group_id"--> statement-breakpoint
UPDATE "product"."purchase_request_lines" t SET "new_group_id" = r."new_id"
FROM "product"."tier_merge_remap" r WHERE r."kind" = 'group' AND r."old_id" = t."new_group_id"--> statement-breakpoint
-- 4. Xoá bản sao (nhóm trước: trục và mẫu của nhóm giữ khoá ngoại RESTRICT tới thuộc tính, thông số).
DELETE FROM "product"."product_groups" t USING "product"."tier_merge_remap" r WHERE r."kind" = 'group' AND r."old_id" = t."id"--> statement-breakpoint
DELETE FROM "product"."spec_field_options" t USING "product"."tier_merge_remap" r WHERE r."kind" = 'spec_option' AND r."old_id" = t."id"--> statement-breakpoint
DELETE FROM "product"."spec_fields" t USING "product"."tier_merge_remap" r WHERE r."kind" = 'spec_field' AND r."old_id" = t."id"--> statement-breakpoint
DELETE FROM "product"."attribute_values" t USING "product"."tier_merge_remap" r WHERE r."kind" = 'attribute_value' AND r."old_id" = t."id"--> statement-breakpoint
DELETE FROM "product"."attributes" t USING "product"."tier_merge_remap" r WHERE r."kind" = 'attribute' AND r."old_id" = t."id"--> statement-breakpoint
-- 5. Thông số của công ty không gộp được (khác kiểu nhập) mà trùng mã, tên dòng nền tảng: đổi mã, tên (service chặn trùng tầng).
UPDATE "product"."spec_fields" f SET "code" = left(f."code", 36) || '_cty', "version" = f."version" + 1, "updated_at" = now()
WHERE f."company_id" IS NOT NULL AND EXISTS (SELECT 1 FROM "product"."spec_fields" p WHERE p."company_id" IS NULL AND p."code" = f."code")--> statement-breakpoint
UPDATE "product"."spec_fields" f SET "name" = left(f."name", 32) || ' (riêng)', "version" = f."version" + 1, "updated_at" = now()
WHERE f."company_id" IS NOT NULL AND EXISTS (SELECT 1 FROM "product"."spec_fields" p WHERE p."company_id" IS NULL AND lower(p."name") = lower(f."name"))--> statement-breakpoint
UPDATE "product"."attributes" SET "platform_kind" = NULL WHERE "company_id" IS NOT NULL AND "platform_kind" IS NOT NULL--> statement-breakpoint
ALTER TABLE "product"."attributes" ADD CONSTRAINT "attributes_platform_kind_tier" CHECK ("platform_kind" IS NULL OR "company_id" IS NULL)--> statement-breakpoint
ALTER TABLE "product"."product_attribute_value_images" ADD CONSTRAINT "pavi_product_fk"
  FOREIGN KEY ("product_id", "attribute_id") REFERENCES "product"."products" ("id", "image_attribute_id")--> statement-breakpoint
ALTER TABLE "product"."product_attribute_value_images" ADD CONSTRAINT "pavi_value_fk"
  FOREIGN KEY ("attribute_value_id", "attribute_id") REFERENCES "product"."attribute_values" ("id", "attribute_id")--> statement-breakpoint
ALTER TABLE "product"."product_spec_values" ADD CONSTRAINT "psv_option_fk"
  FOREIGN KEY ("option_id", "field_id") REFERENCES "product"."spec_field_options" ("id", "field_id") ON DELETE RESTRICT;
