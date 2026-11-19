-- #400 BE3 (plan AC-S7, A18): chép ghép danh mục cũ (`channel.category_maps`) sang spec lần cuối, ngay trước migration
-- `*_bo-ghep-danh-muc` xoá bảng. Khe BE2–BE3 code còn chép lười và route ghép cũ còn sửa ghép, nên chạy lại:
-- (1) Câu chép của `*_chep-spec-tu-ghep-danh-muc`: sản phẩm chưa có spec của sàn mà danh mục đã ghép → spec `version = 0`
--     (bản chép), `source = 'push'`, attribute giữ nguyên khoá, mọi trục của biến thể `__custom`. Spec có sẵn giữ nguyên.
-- (2) Bản chép `version = 0` theo ghép hiện tại (ghép sửa trong khe mà lần chép trước chưa thấy): khác category hay attribute
--     thì ghi lại cả hai, `category_status = 'ok'` như route ghép cũ làm. Không khác thì không đụng (giữ `changed`/`removed`
--     do đồng bộ ghi). Spec đã lưu qua route mới (`version ≥ 1`) không bị đè.
-- (3) Quy tắc bảng kích cỡ sang `platform_categories` như `*_chep-spec-tu-ghep-danh-muc` (ghép sửa trong khe có thể trỏ
--     category mới): dòng có sẵn chỉ điền khi null, dòng mới là dòng tạm `synced_at` null.
-- Chạy lại vô hại. Role chủ bảng chạy migration bỏ qua RLS (không bật FORCE).
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
UPDATE "channel"."product_specs" s
SET
  "external_category_id" = m."external_category_id",
  "attributes" = m."attributes",
  "category_status" = 'ok',
  "updated_at" = now()
FROM "channel"."category_maps" m
JOIN "product"."products" p ON p."category_id" = m."category_id" AND p."company_id" = m."company_id"
WHERE s."product_id" = p."id"
  AND s."platform" = m."platform"
  AND s."company_id" = m."company_id"
  AND s."version" = 0
  AND (s."external_category_id" IS DISTINCT FROM m."external_category_id" OR s."attributes" IS DISTINCT FROM m."attributes");
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
