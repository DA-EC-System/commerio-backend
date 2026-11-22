-- #434 (viết tay, chỉ dữ liệu, chạy lại được): cân nặng trên 50.000 g, cạnh trên 2.000 mm (Documents/21 §17.5) chỉ có
-- trong dữ liệu thử trên staging (PATCH SKU trước #434 không chặn). Xoá trống ô vượt trần để CHECK
-- `product_variants_dimensions` siết ở migration sau thêm được. Tăng `version` để form đang mở nhận 409 thay vì ghi đè.
UPDATE "product"."product_variants" SET
  "weight_g" = CASE WHEN "weight_g" > 50000 THEN NULL ELSE "weight_g" END,
  "length_mm" = CASE WHEN "length_mm" > 2000 THEN NULL ELSE "length_mm" END,
  "width_mm" = CASE WHEN "width_mm" > 2000 THEN NULL ELSE "width_mm" END,
  "height_mm" = CASE WHEN "height_mm" > 2000 THEN NULL ELSE "height_mm" END,
  "version" = "version" + 1,
  "updated_at" = now()
WHERE "weight_g" > 50000 OR "length_mm" > 2000 OR "width_mm" > 2000 OR "height_mm" > 2000;
