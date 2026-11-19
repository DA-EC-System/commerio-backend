-- #400 BE2 (Documents/19 mục 3.3, plan AC-S7, A18): chép ghép danh mục Commerio cũ (`channel.category_maps`) sang spec theo
-- sản phẩm, để sản phẩm hôm nay đẩy được vẫn đẩy được khi đẩy đọc `product_specs`.
-- (1) Mỗi dòng ghép → một spec cho từng sản phẩm của danh mục đó trong cùng công ty: `source = 'push'`, `category_status = 'ok'`,
--     `version = 0` (bản chép; route ghép cũ còn cập nhật bản này tới BE3), attribute giữ nguyên khoá (Lazada `name`, TikTok id),
--     mọi trục phân loại của biến thể ánh xạ `__custom`, `value_map` rỗng. Spec có sẵn (người dùng đã chọn) giữ nguyên.
-- (2) Quy tắc bảng kích cỡ (#347) sang `platform_categories`: một dòng nguồn mỗi category sàn (`distinct on`, dòng có quy tắc,
--     `required` trước); dòng category có sẵn chỉ điền khi còn null, không đổi tên, đường dẫn, trạng thái; dòng mới là dòng tạm
--     (`synced_at` null, tên và đường dẫn là mã; tìm kiếm bỏ qua, lượt đồng bộ cây ghi đè). Ghép chưa có quy tắc không tạo dòng.
-- Chạy lại vô hại (BE3 chạy lại câu chép rồi xoá bảng cũ). Chép lười trong code (`specsWithCopy`) cùng luật.
-- Role chủ bảng chạy migration bỏ qua RLS (không bật FORCE).
INSERT INTO "channel"."product_specs"
  ("company_id", "product_id", "platform", "external_category_id", "attributes", "axis_map", "value_map", "source", "category_status", "version")
SELECT
  m."company_id",
  p."id",
  m."platform",
  m."external_category_id",
  m."attributes",
  coalesce(
    (
      SELECT jsonb_object_agg(axes."attribute_id"::text, '"__custom"'::jsonb)
      FROM (
        SELECT DISTINCT av."attribute_id"
        FROM "product"."product_variants" v
        JOIN "product"."variant_attribute_values" vav ON vav."variant_id" = v."id"
        JOIN "product"."attribute_values" av ON av."id" = vav."attribute_value_id"
        WHERE v."product_id" = p."id"
      ) axes
    ),
    '{}'::jsonb
  ),
  '{}'::jsonb,
  'push',
  'ok',
  0
FROM "channel"."category_maps" m
JOIN "product"."products" p ON p."category_id" = m."category_id" AND p."company_id" = m."company_id"
ON CONFLICT ("product_id", "platform") DO NOTHING;
--> statement-breakpoint
INSERT INTO "channel"."platform_categories"
  ("platform", "external_id", "name", "is_leaf", "path", "path_search", "status", "synced_at", "size_chart_rule")
SELECT DISTINCT ON (m."platform", m."external_category_id")
  m."platform",
  m."external_category_id",
  m."external_category_id",
  true,
  m."external_category_id",
  lower(m."external_category_id"),
  'active',
  NULL,
  m."size_chart_rule"
FROM "channel"."category_maps" m
WHERE m."size_chart_rule" IS NOT NULL
ORDER BY m."platform", m."external_category_id",
  CASE m."size_chart_rule" WHEN 'required' THEN 0 WHEN 'optional' THEN 1 ELSE 2 END,
  m."updated_at" DESC
ON CONFLICT ("platform", "external_id") DO UPDATE
  SET "size_chart_rule" = coalesce("channel"."platform_categories"."size_chart_rule", excluded."size_chart_rule");
