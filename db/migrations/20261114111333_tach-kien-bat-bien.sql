-- Bất biến dòng kiện (spec 205 D1, D11; Documents/25 §8): tổng số lượng một dòng đơn trên các kiện chưa huỷ không vượt số
-- lượng dòng đơn. Kiểm lúc commit (trong giao dịch dòng kiện đi qua trạng thái trung gian). Không khoá dòng đơn: luồng
-- nhận đơn khoá dòng đơn trước kiện, tách kiện khoá kiện trước; khoá ở đây sẽ thành vòng khoá. PR 2 siết thành kiểm bằng.
-- Lùi: DROP TRIGGER package_lines_line_total ON "order".package_lines; DROP FUNCTION "order".check_package_line_total();
CREATE FUNCTION "order".check_package_line_total() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  ordered integer;
  placed integer;
BEGIN
  SELECT ol.quantity INTO ordered FROM "order".order_lines ol WHERE ol.id = NEW.order_line_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT coalesce(sum(pl.quantity), 0) INTO placed
    FROM "order".package_lines pl
    JOIN "order".packages p ON p.id = pl.package_id
   WHERE pl.order_line_id = NEW.order_line_id AND p.status <> 'cancelled';
  IF placed > ordered THEN
    RAISE EXCEPTION 'Dòng đơn % nằm trong các kiện với tổng % món, vượt % món của dòng', NEW.order_line_id, placed, ordered
      USING ERRCODE = 'check_violation', CONSTRAINT = 'package_lines_line_total', SCHEMA = 'order', TABLE = 'package_lines';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER package_lines_line_total
  AFTER INSERT OR UPDATE OF quantity, package_id, order_line_id ON "order".package_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "order".check_package_line_total();
