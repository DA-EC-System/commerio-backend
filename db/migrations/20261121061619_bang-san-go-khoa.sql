-- Gỡ khoá ngoại ghép spec_option_mappings_field_fk (viết tay ở *_anh-xa-hai-tang-du-lieu) trước khi đổi cột platform từ enum sang text (Documents/19 mục 3.3, 21/11/2026): Postgres không đổi kiểu từng bảng được khi khoá ngoại ghép còn. Gắn lại ở *_bang-san-fk.
ALTER TABLE channel.spec_option_mappings DROP CONSTRAINT IF EXISTS spec_option_mappings_field_fk;
