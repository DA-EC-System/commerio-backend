-- #497: nguồn từng attribute của spec đã có. Spec tạo trước #497 chỉ có nguồn của cả spec (`source`): mọi attribute mang nguồn đó
-- (`push` là bản lưu ở trang đẩy hoặc bản chép, `match` là bản đọc từ sàn khi ghép). Lần lưu sau tính lại theo từng ô.
UPDATE "channel"."product_specs" s
SET "field_sources" = COALESCE((SELECT jsonb_object_agg(k, s."source") FROM jsonb_object_keys(s."attributes") AS k), '{}'::jsonb)
WHERE s."field_sources" = '{}'::jsonb AND s."attributes" <> '{}'::jsonb;
