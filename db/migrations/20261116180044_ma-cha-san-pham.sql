-- #204 PR 3 (spec 2026-11-16-204 mục 5.3, D4, D5, D11): bỏ lưu trữ sản phẩm cha, thêm mã cha `code`.
-- Sinh bằng drizzle-kit rồi viết tay phần dữ liệu (db:regen báo khi các câu viết tay bị mất). Cột `archived_at` của cha
-- bỏ ở migration kế tiếp (`bo-luu-tru-san-pham-cha`); hai file chạy trong cùng một giao dịch của migrator.

-- 1. D11: SKU chưa lưu trữ của sản phẩm cha đang lưu trữ. Còn tồn thực, đang giữ hoặc chờ xử lý thì Ngừng nhập; còn lại
--    lưu trữ, `archived_at` lấy của cha. Chỉ đọc bảng của schema `product`; không phát sự kiện, không ghi lịch sử.
UPDATE "product"."product_variants" pv
SET "business_status" = CASE
      WHEN EXISTS (
        SELECT 1 FROM "product"."stock_levels" sl
        WHERE sl."variant_id" = pv."id" AND (sl."on_hand" <> 0 OR sl."reserved" <> 0 OR sl."quarantine" <> 0)
      ) THEN 'discontinued'::"product"."business_status"
      ELSE 'archived'::"product"."business_status"
    END,
    "archived_at" = CASE
      WHEN EXISTS (
        SELECT 1 FROM "product"."stock_levels" sl
        WHERE sl."variant_id" = pv."id" AND (sl."on_hand" <> 0 OR sl."reserved" <> 0 OR sl."quarantine" <> 0)
      ) THEN NULL
      ELSE p."archived_at"
    END,
    "version" = pv."version" + 1,
    "updated_at" = now()
FROM "product"."products" p
WHERE p."id" = pv."product_id" AND p."archived_at" IS NOT NULL AND pv."business_status" <> 'archived';--> statement-breakpoint
DROP INDEX "product"."products_company_lower_name_uq";--> statement-breakpoint
ALTER TABLE "product"."products" ADD COLUMN "code" text;--> statement-breakpoint
CREATE UNIQUE INDEX "products_company_code_uq" ON "product"."products" USING btree ("company_id","code");--> statement-breakpoint
-- 2. D5: mã cha của sản phẩm đã có = SKU của biến thể tạo sớm nhất bỏ phần mã giá trị thuộc tính (như `renderSku` với
--    `{VAL}` rỗng: gộp dấu nối liền nhau, cắt dấu nối hai đầu), rỗng thì lấy nguyên SKU. Cấp theo thứ tự tạo sản phẩm,
--    mã đã có trong công ty thì thêm `-2`, `-3`… như `productCodeFor`. Sản phẩm không có biến thể (không có qua API) lấy
--    `SP-` cộng 8 ký tự đầu của id.
DO $$
DECLARE
  r record;
  candidate text;
  n integer;
BEGIN
  FOR r IN
    WITH first_variant AS (
      SELECT DISTINCT ON (pv."product_id") pv."product_id", pv."id", pv."sku"
      FROM "product"."product_variants" pv
      ORDER BY pv."product_id", pv."created_at", pv."sku"
    ), vals AS (
      SELECT fv."product_id", fv."sku", coalesce(string_agg(av."code", '-' ORDER BY vav."position"), '') AS val
      FROM first_variant fv
      LEFT JOIN "product"."variant_attribute_values" vav ON vav."variant_id" = fv."id"
      LEFT JOIN "product"."attribute_values" av ON av."id" = vav."attribute_value_id"
      GROUP BY fv."product_id", fv."sku"
    )
    SELECT p."id", p."company_id",
      CASE
        WHEN v."sku" IS NULL THEN 'SP-' || upper(left(p."id"::text, 8))
        WHEN v.val = '' THEN v."sku"
        ELSE coalesce(
          nullif(trim(both '-_' from regexp_replace(replace(v."sku", v.val, ''), '([-_]){2,}', '\1', 'g')), ''),
          v."sku"
        )
      END AS base
    FROM "product"."products" p
    LEFT JOIN vals v ON v."product_id" = p."id"
    ORDER BY p."created_at", p."id"
  LOOP
    candidate := r.base;
    n := 1;
    WHILE EXISTS (SELECT 1 FROM "product"."products" WHERE "company_id" = r."company_id" AND "code" = candidate) LOOP
      n := n + 1;
      candidate := r.base || '-' || n;
    END LOOP;
    UPDATE "product"."products" SET "code" = candidate WHERE "id" = r."id";
  END LOOP;
END
$$;--> statement-breakpoint
-- 3. D4: tên không trùng trên mọi sản phẩm. Sản phẩm đang lưu trữ trùng tên (chữ thường) với sản phẩm khác cùng công ty
--    thêm hậu tố ` (<mã cha>)`; tăng `version` như mọi lần đổi bản ghi.
UPDATE "product"."products" p
SET "name" = p."name" || ' (' || p."code" || ')', "version" = p."version" + 1, "updated_at" = now()
WHERE p."archived_at" IS NOT NULL AND EXISTS (
  SELECT 1 FROM "product"."products" o
  WHERE o."company_id" = p."company_id" AND o."id" <> p."id" AND lower(o."name") = lower(p."name")
);--> statement-breakpoint
ALTER TABLE "product"."products" ALTER COLUMN "code" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "products_company_lower_name_uq" ON "product"."products" USING btree ("company_id",lower("name"));
