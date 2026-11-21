-- Ánh xạ sang sàn hai tầng (dữ liệu chung, Documents/19 §3.3, 21 §18.8.1, §5.6, be#522). Chạy sau `*_du-lieu-chung-chuyen`
-- (be#521): bản sao thông số, lựa chọn, thuộc tính, giá trị theo công ty đã gộp vào dòng nền tảng (company_id NULL), cặp id
-- cũ → mới ở `product.tier_merge_remap`; lựa chọn, giá trị riêng không khớp giữ id cũ, đổi field_id/attribute_id sang dòng nền tảng.
-- Thứ tự: chuyển dữ liệu, rồi khoá ngoại (thêm trước thì xoá dòng mã bản sao sẽ xoá dây chuyền ánh xạ lựa chọn riêng), RLS.
-- 1) Trục, giá trị đã ghép của spec trỏ id thuộc tính, giá trị catalog: đổi khoá theo bảng gộp; spec đã lưu tăng `version`.
UPDATE channel.product_specs s
SET axis_map = (
      SELECT coalesce(jsonb_object_agg(coalesce(r.new_id::text, e.key), e.value), '{}'::jsonb)
      FROM jsonb_each(s.axis_map) e
      LEFT JOIN product.tier_merge_remap r ON r.kind = 'attribute' AND r.old_id::text = e.key
    ),
    value_map = (
      SELECT coalesce(jsonb_object_agg(coalesce(r.new_id::text, e.key), e.value), '{}'::jsonb)
      FROM jsonb_each(s.value_map) e
      LEFT JOIN product.tier_merge_remap r ON r.kind = 'attribute_value' AND r.old_id::text = e.key
    ),
    version = s.version + 1
WHERE EXISTS (
  SELECT 1 FROM product.tier_merge_remap r
  WHERE (r.kind = 'attribute' AND s.axis_map ? r.old_id::text) OR (r.kind = 'attribute_value' AND s.value_map ? r.old_id::text)
);--> statement-breakpoint
-- 2) Ánh xạ lựa chọn đi theo thông số, lựa chọn đã gộp (lựa chọn riêng trên thông số nay là chuẩn trỏ sang dòng mã nền tảng).
UPDATE channel.spec_option_mappings o SET field_id = r.new_id
FROM product.tier_merge_remap r WHERE r.kind = 'spec_field' AND r.old_id = o.field_id;--> statement-breakpoint
UPDATE channel.spec_option_mappings o SET option_id = r.new_id
FROM product.tier_merge_remap r WHERE r.kind = 'spec_option' AND r.old_id = o.option_id;--> statement-breakpoint
-- 3) Ánh xạ phải cùng tầng với dòng catalog nó trỏ tới: dòng mã của bản sao đã xoá, ánh xạ lựa chọn nay là chuẩn (chốt: ánh xạ
-- chuẩn chỉ nền tảng giữ), ánh xạ trục của thuộc tính nay là chuẩn thì bỏ. Ánh xạ của dữ liệu riêng giữ nguyên.
DELETE FROM channel.spec_field_mappings m
WHERE NOT EXISTS (SELECT 1 FROM product.spec_fields f WHERE f.id = m.field_id AND f.company_id IS NOT DISTINCT FROM m.company_id);--> statement-breakpoint
DELETE FROM channel.spec_option_mappings m
WHERE NOT EXISTS (SELECT 1 FROM product.spec_field_options o WHERE o.id = m.option_id AND o.company_id IS NOT DISTINCT FROM m.company_id);--> statement-breakpoint
DELETE FROM channel.axis_mappings m
WHERE NOT EXISTS (SELECT 1 FROM product.attributes a WHERE a.id = m.attribute_id AND a.company_id IS NOT DISTINCT FROM m.company_id);--> statement-breakpoint
-- 4) Ánh xạ mặc định của adapter thành dòng nền tảng (chép từ `lazada-spec-mappings.ts`, `tiktok-spec-mappings.ts`; test
-- `spec-mappings-platform.test.ts` so DB với hằng), tra thông số chuẩn theo `code`.
INSERT INTO channel.spec_field_mappings (company_id, field_id, platform, attribute_code, priority)
SELECT NULL, f.id, d.platform::channel.marketplace, d.attribute_code, d.priority
FROM (VALUES
  ('lazada', 'chat_lieu', 'clothing_material', 1),
  ('lazada', 'chat_lieu', 'Sports_Material', 2),
  ('lazada', 'chat_lieu', 'material_filter', 3),
  ('lazada', 'chat_lieu', 'material', 4),
  ('lazada', 'chat_lieu', 'material_type', 5),
  ('lazada', 'chat_lieu', 'frame_material', 6),
  ('lazada', 'chat_lieu', 'pillow_fabric', 7),
  ('lazada', 'chat_lieu', 'cookware_material', 8),
  ('lazada', 'chat_lieu', 'Baby_Material', 9),
  ('lazada', 'chat_lieu', 'outer_material', 10),
  ('lazada', 'chat_lieu', 'Type_of_Material', 11),
  ('lazada', 'hoa_tiet', 'fa_pattern', 1),
  ('lazada', 'dang', 'Fit_Type', 1),
  ('lazada', 'dang', 'dress_shape', 2),
  ('lazada', 'dang', 'skirt_style', 3),
  ('lazada', 'co_ao', 'Neckline', 1),
  ('lazada', 'do_dai_tay', 'w_sleeve_length', 1),
  ('lazada', 'kieu_quan', 'jeans_fit_type', 1),
  ('lazada', 'kieu_quan', 'pants_fit_type', 2),
  ('lazada', 'cap_quan', 'waist_type', 1),
  ('lazada', 'do_dai_vay', 'dress_length', 1),
  ('lazada', 'do_dai_vay', 'skirt_length', 2),
  ('lazada', 'trang_tri', 'clothing_decoration', 1),
  ('lazada', 'phong_cach', 'fa_general_styles', 1),
  ('lazada', 'dip_mac', 'occasion', 1),
  ('lazada', 'tinh_nang', 'yoga_mat_feature', 1),
  ('lazada', 'doi_tuong', 'recommended_gender', 1),
  ('lazada', 'doi_tuong', 'is_unisex', 2),
  ('lazada', 'kieu_buoc', 'shoes_closuretype', 1),
  ('lazada', 'chat_lieu_de', 'Outsole_Material', 1),
  ('lazada', 'co_giay', 'sneaker_upperheight', 1),
  ('lazada', 'dac_diem', 'sport_Features', 1),
  ('lazada', 'dac_diem', 'Bag_Feature_Design', 2),
  ('lazada', 'dac_diem', 'cookware_feature', 3),
  ('lazada', 'dac_diem', 'Food_Container_Features', 4),
  ('lazada', 'be_rong', 'Width_Fit', 1),
  ('lazada', 'loai_tui', 'Bag_type', 1),
  ('lazada', 'loai_tui', 'wallet_types', 2),
  ('lazada', 'loai_tui', 'backpack_types', 3),
  ('lazada', 'kieu_khoa', 'Closure_Type', 1),
  ('lazada', 'co_tui', 'Bag_Size', 1),
  ('lazada', 'kich_thuoc', 'Cushion_Size', 1),
  ('lazada', 'dung_tich_lit', 'backpack_capacity', 1),
  ('lazada', 'dung_tich_ml', 'cookware_capacity', 1),
  ('lazada', 'dung_tich_ml', 'capacity', 2),
  ('lazada', 'loai_da', 'skin_type', 1),
  ('lazada', 'cong_dung', 'skin_benefit', 1),
  ('lazada', 'dang_san_pham', 'fmlt_skin_care', 1),
  ('lazada', 'dang_san_pham', 'formulation', 2),
  ('lazada', 'han_su_dung', 'shelf_expiry', 1),
  ('lazada', 'chi_so_chong_nang', 'sun_protection', 1),
  ('lazada', 'chi_so_pa', 'PA', 1),
  ('lazada', 'hoan_thien', 'finish', 1),
  ('lazada', 'so_mon', 'number_of_pieces', 1),
  ('lazada', 'bep_tuong_thich', 'Cookware_Compatibility', 1),
  ('lazada', 'loai_bao_hanh', 'warranty_type', 1),
  ('lazada', 'thoi_han_bao_hanh', 'warranty', 1),
  ('lazada', 'model', 'model', 1),
  ('lazada', 'tinh_trang', 'condition', 1),
  ('lazada', 'cong_ket_noi', 'input_type', 1),
  ('lazada', 'cong_ket_noi', 'Outputs', 2),
  ('lazada', 'dung_luong_pin', 'powerbank_capacity', 1),
  ('lazada', 'bluetooth', 'Bluetooth_version', 1),
  ('lazada', 'sac_nhanh', 'powerbank_feature', 1),
  ('lazada', 'thiet_bi_tuong_thich', 'compatible_devices', 1),
  ('lazada', 'dien_ap', 'input_voltage', 1),
  ('lazada', 'chuan_chong_nuoc', 'Water_Resistance_Rating', 1),
  ('lazada', 'cach_bao_quan', 'product_type', 1),
  ('lazada', 'loai_bao_bi', 'packaging_type', 1),
  ('lazada', 'huu_co', 'organic', 1),
  ('lazada', 'di_ung', 'dietary_needs', 1),
  ('lazada', 'do_tuoi', 'recommended_age', 1),
  ('lazada', 'do_tuoi', 'recommended_user', 2),
  ('lazada', 'an_toan_vat_lieu', 'Material_Feature', 1),
  ('lazada', 'so_mieng_ta', 'diaper_pack_size', 1),
  ('lazada', 'loai_ta', 'type_diaper', 1),
  ('lazada', 'mon_the_thao', 'activity_type', 1),
  ('tiktok', 'chat_lieu', '100157', 1),
  ('tiktok', 'chat_lieu', '100701', 2),
  ('tiktok', 'chat_lieu', '100452', 3),
  ('tiktok', 'chat_lieu', '100466', 4),
  ('tiktok', 'chat_lieu', '100467', 5),
  ('tiktok', 'chat_lieu', '100197', 6),
  ('tiktok', 'chat_lieu', '100730', 7),
  ('tiktok', 'hoa_tiet', '100198', 1),
  ('tiktok', 'dang', '100399', 1),
  ('tiktok', 'co_ao', '100393', 1),
  ('tiktok', 'do_dai_tay', '100395', 1),
  ('tiktok', 'cap_quan', '100403', 1),
  ('tiktok', 'do_dai_vay', '100405', 1),
  ('tiktok', 'do_dai_vay', '100402', 2),
  ('tiktok', 'trang_tri', '100406', 1),
  ('tiktok', 'phong_cach', '100398', 1),
  ('tiktok', 'phong_cach', '100460', 2),
  ('tiktok', 'phong_cach', '100468', 3),
  ('tiktok', 'dip_mac', '100392', 1),
  ('tiktok', 'mua', '100397', 1),
  ('tiktok', 'tinh_nang', '100654', 1),
  ('tiktok', 'tinh_nang', '100697', 2),
  ('tiktok', 'huong_dan_giat', '100401', 1),
  ('tiktok', 'doi_tuong', '100445', 1),
  ('tiktok', 'kieu_buoc', '100422', 1),
  ('tiktok', 'co_giay', '101151', 1),
  ('tiktok', 'do_cao_got', '100421', 1),
  ('tiktok', 'dac_diem', '100443', 1),
  ('tiktok', 'dac_diem', '100820', 2),
  ('tiktok', 'be_rong', '101150', 1),
  ('tiktok', 'loai_tui', '100434', 1),
  ('tiktok', 'loai_da_thuoc', '100196', 1),
  ('tiktok', 'kich_thuoc', '100516', 1),
  ('tiktok', 'kich_thuoc', '100678', 2),
  ('tiktok', 'kich_thuoc', '100696', 3),
  ('tiktok', 'cach_mang', '100440', 1),
  ('tiktok', 'dung_tich_ml', '100343', 1),
  ('tiktok', 'dung_tich_ml', '100606', 2),
  ('tiktok', 'loai_da', '100334', 1),
  ('tiktok', 'cong_dung', '101310', 1),
  ('tiktok', 'dang_san_pham', '100335', 1),
  ('tiktok', 'han_su_dung', '100337', 1),
  ('tiktok', 'chi_so_chong_nang', '100349', 1),
  ('tiktok', 'hoan_thien', '100351', 1),
  ('tiktok', 'thanh_phan', '100346', 1),
  ('tiktok', 'loai_giay_phep', '102872', 1),
  ('tiktok', 'so_giay_phep', '102999', 1),
  ('tiktok', 'ngay_cap', '103000', 1),
  ('tiktok', 'noi_cap', '103001', 1),
  ('tiktok', 'so_mon', '100347', 1),
  ('tiktok', 'loai_bao_hanh', '100107', 1),
  ('tiktok', 'thoi_han_bao_hanh', '100495', 1),
  ('tiktok', 'model', '100177', 1),
  ('tiktok', 'tinh_trang', '100115', 1),
  ('tiktok', 'cong_ket_noi', '100206', 1),
  ('tiktok', 'cong_ket_noi', '100232', 2),
  ('tiktok', 'dung_luong_pin', '100207', 1),
  ('tiktok', 'dung_luong_pin', '100111', 2),
  ('tiktok', 'sac_nhanh', '100191', 1),
  ('tiktok', 'chua_pin', '101610', 1),
  ('tiktok', 'chua_pin', '101611', 2),
  ('tiktok', 'dien_ap', '100203', 1),
  ('tiktok', 'dien_ap', '100114', 2),
  ('tiktok', 'cach_bao_quan', '100702', 1),
  ('tiktok', 'loai_bao_bi', '100481', 1),
  ('tiktok', 'huu_co', '100476', 1),
  ('tiktok', 'di_ung', '100341', 1),
  ('tiktok', 'do_tuoi', '100433', 1),
  ('tiktok', 'do_tuoi', '101399', 2),
  ('tiktok', 'gioi_tinh_be', '100491', 1),
  ('tiktok', 'an_toan_vat_lieu', '100496', 1),
  ('tiktok', 'mon_the_thao', '100655', 1),
  ('tiktok', 'mon_the_thao', '100667', 2)
) AS d(platform, field_code, attribute_code, priority)
JOIN product.spec_fields f ON f.company_id IS NULL AND f.code = d.field_code
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Mã đã thuộc thông số chuẩn thì thông số riêng của công ty nhường (một mã của sàn chỉ nhận từ một thông số).
DELETE FROM channel.spec_field_mappings c
WHERE c.company_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM channel.spec_field_mappings p WHERE p.company_id IS NULL AND p.platform = c.platform AND p.attribute_code = c.attribute_code);--> statement-breakpoint
-- Ánh xạ lựa chọn không còn dòng mã (đúng thông số, sàn, mã) thì bỏ; trùng sau khi gộp giữ một dòng.
DELETE FROM channel.spec_option_mappings o
WHERE NOT EXISTS (
  SELECT 1 FROM channel.spec_field_mappings m WHERE m.field_id = o.field_id AND m.platform = o.platform AND m.attribute_code = o.attribute_code
);--> statement-breakpoint
DELETE FROM channel.spec_option_mappings o USING channel.spec_option_mappings k
WHERE o.option_id = k.option_id AND o.platform = k.platform AND o.attribute_code = k.attribute_code AND o.id > k.id;--> statement-breakpoint
-- 5) Khoá ngoại lựa chọn → dòng mã, không kèm company_id (lựa chọn riêng của công ty trỏ dòng mã nền tảng). Viết tay vì drizzle
-- sinh câu thêm khoá ngoại trước câu tạo unique `spec_field_mappings_field_code_uq` nó trỏ tới (schema.ts không khai khoá này).
ALTER TABLE channel.spec_option_mappings ADD CONSTRAINT spec_option_mappings_field_fk FOREIGN KEY (field_id, platform, attribute_code)
  REFERENCES channel.spec_field_mappings (field_id, platform, attribute_code) ON DELETE CASCADE;--> statement-breakpoint
-- RLS: công ty đọc dòng nền tảng (company_id NULL) và dòng của mình; chỉ ghi dòng của mình. Tách policy theo lệnh: policy
-- đọc gộp dòng NULL mà đặt FOR ALL thì USING cũng áp cho UPDATE, DELETE, công ty sửa được dòng nền tảng.
DROP POLICY company_isolation ON channel.spec_field_mappings;--> statement-breakpoint
CREATE POLICY tier_read ON channel.spec_field_mappings FOR SELECT USING (company_id IS NULL OR company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tier_insert ON channel.spec_field_mappings FOR INSERT WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tier_update ON channel.spec_field_mappings FOR UPDATE USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tier_delete ON channel.spec_field_mappings FOR DELETE USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
DROP POLICY company_isolation ON channel.spec_option_mappings;--> statement-breakpoint
CREATE POLICY tier_read ON channel.spec_option_mappings FOR SELECT USING (company_id IS NULL OR company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tier_insert ON channel.spec_option_mappings FOR INSERT WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tier_update ON channel.spec_option_mappings FOR UPDATE USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tier_delete ON channel.spec_option_mappings FOR DELETE USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
DROP POLICY company_isolation ON channel.axis_mappings;--> statement-breakpoint
CREATE POLICY tier_read ON channel.axis_mappings FOR SELECT USING (company_id IS NULL OR company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tier_insert ON channel.axis_mappings FOR INSERT WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tier_update ON channel.axis_mappings FOR UPDATE USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tier_delete ON channel.axis_mappings FOR DELETE USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
-- 6) Bảng gộp của be#521 chỉ dùng cho bước chuyển này.
DROP TABLE product.tier_merge_remap;
