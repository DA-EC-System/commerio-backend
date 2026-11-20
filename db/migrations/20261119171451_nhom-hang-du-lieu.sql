-- Nhóm hàng (#447, plan A2): công ty có trước bản này nhận thứ công ty mới có từ `seedCompanyDefaults`, không chép đè.
-- Chạy lại được; công ty đăng ký bằng image cũ trong khe đổi image thì chạy lại cả file sau rollout.
-- 1. Cài đặt sản phẩm: mẫu mặc định, số {SEQ} kế tiếp = số SKU của công ty + 1 (cấp số tự nhảy qua SKU trùng).
INSERT INTO "product"."company_product_settings" ("company_id", "sku_next_seq")
SELECT c."id", (SELECT count(*) FROM "product"."product_variants" v WHERE v."company_id" = c."id") + 1
FROM "core"."companies" c
ON CONFLICT ("company_id") DO NOTHING;
--> statement-breakpoint
-- 2. Thuộc tính tương tự đã có ("Màu", "Cỡ", "Size"…) thành thuộc tính chuẩn sàn: thuộc tính tạo sớm nhất của mỗi loại,
-- chỉ khi công ty chưa có thuộc tính mang loại đó.
UPDATE "product"."attributes" a SET "platform_kind" = k."kind", "version" = a."version" + 1, "updated_at" = now()
FROM (
  SELECT DISTINCT ON (x."company_id", m."kind") x."id", m."kind"
  FROM "product"."attributes" x
  JOIN (VALUES ('màu sắc', 'color'), ('màu', 'color'), ('color', 'color'), ('kích cỡ', 'size'), ('cỡ', 'size'), ('size', 'size'))
    AS m("name", "kind") ON m."name" = lower(trim(x."name"))
  ORDER BY x."company_id", m."kind", x."created_at", x."id"
) k
WHERE a."id" = k."id"
  AND NOT EXISTS (SELECT 1 FROM "product"."attributes" b WHERE b."company_id" = a."company_id" AND b."platform_kind" = k."kind");
--> statement-breakpoint
-- 3. Còn thiếu loại nào thì thêm "Màu sắc", "Kích cỡ" với giá trị mặc định (như seed; `created_at` tăng dần giữ thứ tự hiện).
WITH "added" AS (
  INSERT INTO "product"."attributes" ("company_id", "name", "platform_kind", "created_at", "updated_at")
  SELECT c."id", s."name", s."kind", now() + s."pos" * interval '1 millisecond', now()
  FROM "core"."companies" c
  CROSS JOIN (VALUES (0, 'color', 'Màu sắc'), (1, 'size', 'Kích cỡ')) AS s("pos", "kind", "name")
  WHERE NOT EXISTS (SELECT 1 FROM "product"."attributes" a WHERE a."company_id" = c."id" AND a."platform_kind" = s."kind")
  ON CONFLICT DO NOTHING
  RETURNING "id", "company_id", "platform_kind"
)
INSERT INTO "product"."attribute_values" ("company_id", "attribute_id", "value", "code", "created_at", "updated_at")
SELECT d."company_id", d."id", v."value", v."code", now() + v."pos" * interval '1 millisecond', now()
FROM "added" d
JOIN (VALUES
  ('color', 0, 'Đen', 'DEN'), ('color', 1, 'Trắng', 'TRANG'), ('color', 2, 'Đỏ', 'DO'), ('color', 3, 'Xanh dương', 'XANHDU'),
  ('color', 4, 'Vàng', 'VANG'), ('color', 5, 'Hồng', 'HONG'), ('color', 6, 'Xám', 'XAM'), ('color', 7, 'Be', 'BE'),
  ('size', 0, 'S', 'S'), ('size', 1, 'M', 'M'), ('size', 2, 'L', 'L'), ('size', 3, 'XL', 'XL'), ('size', 4, 'XXL', 'XXL')
) AS v("kind", "pos", "value", "code") ON v."kind" = d."platform_kind";
--> statement-breakpoint
-- 4. Công ty chưa có nhóm hàng nào (danh mục cũ đã thành nhóm) nhận 12 nhóm có sẵn.
INSERT INTO "product"."product_groups" ("company_id", "name", "created_at", "updated_at")
SELECT c."id", g."name", now() + g."pos" * interval '1 millisecond', now()
FROM "core"."companies" c
CROSS JOIN (VALUES
  (0, 'Thời trang nam'), (1, 'Thời trang nữ'), (2, 'Giày dép'), (3, 'Túi ví'), (4, 'Phụ kiện'), (5, 'Mỹ phẩm & làm đẹp'),
  (6, 'Nhà cửa & đời sống'), (7, 'Điện tử'), (8, 'Thực phẩm'), (9, 'Mẹ & bé'), (10, 'Thể thao'), (11, 'Khác')
) AS g("pos", "name")
WHERE NOT EXISTS (SELECT 1 FROM "product"."product_groups" x WHERE x."company_id" = c."id");
