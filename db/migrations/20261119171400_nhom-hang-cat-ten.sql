-- Nhóm hàng (#447), chạy trước migration thêm CHECK tên thuộc tính <= 15, giá trị <= 20 ký tự (luật Lazada `VARIATION_*`,
-- Documents/21 mục 5.2): cắt tên dài hơn, bỏ khoảng trắng cuối; trùng tên trong công ty (thuộc tính) hay trong thuộc tính
-- (giá trị) thì cắt ngắn thêm và nối số 2, 3… Dòng bị đổi tăng `version`. Duyệt theo thứ tự tạo nên dòng cũ giữ tên ngắn.
-- Chạy lại được (lần hai không còn dòng nào dài).
DO $$
DECLARE
  r record;
  cand text;
  n integer;
BEGIN
  FOR r IN SELECT "id", "company_id", "name" FROM "product"."attributes" WHERE char_length("name") > 15 ORDER BY "created_at", "id" LOOP
    cand := rtrim(left(r."name", 15));
    n := 1;
    WHILE EXISTS (
      SELECT 1 FROM "product"."attributes" WHERE "company_id" = r."company_id" AND lower("name") = lower(cand) AND "id" <> r."id"
    ) LOOP
      n := n + 1;
      cand := rtrim(left(r."name", 15 - char_length(n::text))) || n::text;
    END LOOP;
    UPDATE "product"."attributes" SET "name" = cand, "version" = "version" + 1, "updated_at" = now() WHERE "id" = r."id";
  END LOOP;

  FOR r IN SELECT "id", "attribute_id", "value" FROM "product"."attribute_values" WHERE char_length("value") > 20 ORDER BY "created_at", "id" LOOP
    cand := rtrim(left(r."value", 20));
    n := 1;
    WHILE EXISTS (
      SELECT 1 FROM "product"."attribute_values" WHERE "attribute_id" = r."attribute_id" AND lower("value") = lower(cand) AND "id" <> r."id"
    ) LOOP
      n := n + 1;
      cand := rtrim(left(r."value", 20 - char_length(n::text))) || n::text;
    END LOOP;
    UPDATE "product"."attribute_values" SET "value" = cand, "version" = "version" + 1, "updated_at" = now() WHERE "id" = r."id";
  END LOOP;
END $$;
