-- Bất biến dòng kiện, kiểm bằng (spec 205 §5.10, D19; Documents/25 §8): với một dòng đơn,
-- tổng (quantity - pending_drop_qty) trên các kiện chưa huỷ = quantity - cancelled_qty. Thay trigger chặn vượt của PR 1.
-- Kiểm lúc commit, không khoá dòng đơn (D11). `require_lines` false: dòng đơn chưa có dòng kiện nào thì bỏ qua.
-- Trigger trên `packages` chỉ chạy khi trạng thái qua lại ranh giới `cancelled`, trên `order_lines` chỉ khi số lượng hoặc
-- số đã huỷ đổi giá trị (D19): điều kiện `WHEN` xét ngay lúc dòng đổi, chỉ việc chạy hàm hoãn tới commit.
-- Lùi: DROP ba trigger và ba hàm dưới đây (kèm "order".assert_package_line_total), rồi chạy lại nội dung migration
-- *_tach-kien-bat-bien.
DROP TRIGGER package_lines_line_total ON "order".package_lines;
--> statement-breakpoint
DROP FUNCTION "order".check_package_line_total();
--> statement-breakpoint
CREATE FUNCTION "order".assert_package_line_total(line_id uuid, require_lines boolean) RETURNS void
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  effective integer;
  placed integer;
BEGIN
  SELECT ol.quantity - ol.cancelled_qty INTO effective FROM "order".order_lines ol WHERE ol.id = line_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF NOT require_lines AND NOT EXISTS (SELECT 1 FROM "order".package_lines pl WHERE pl.order_line_id = line_id) THEN
    RETURN;
  END IF;
  SELECT coalesce(sum(pl.quantity - pl.pending_drop_qty), 0) INTO placed
    FROM "order".package_lines pl
    JOIN "order".packages p ON p.id = pl.package_id
   WHERE pl.order_line_id = line_id AND p.status <> 'cancelled';
  IF placed <> effective THEN
    RAISE EXCEPTION 'Dòng đơn % có % món còn hiệu lực trên các kiện, dòng đơn còn hiệu lực % món', line_id, placed, effective
      USING ERRCODE = 'check_violation', CONSTRAINT = 'package_lines_line_total', SCHEMA = 'order', TABLE = 'package_lines';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "order".check_package_line_total() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM "order".assert_package_line_total(OLD.order_line_id, true);
  END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.order_line_id IS DISTINCT FROM OLD.order_line_id) THEN
    PERFORM "order".assert_package_line_total(NEW.order_line_id, true);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "order".check_package_status_line_total() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
BEGIN
  PERFORM "order".assert_package_line_total(pl.order_line_id, true)
    FROM "order".package_lines pl WHERE pl.package_id = NEW.id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "order".check_order_line_total() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
BEGIN
  PERFORM "order".assert_package_line_total(NEW.id, false);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER package_lines_line_total
  AFTER INSERT OR DELETE OR UPDATE OF quantity, package_id, order_line_id, pending_drop_qty ON "order".package_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "order".check_package_line_total();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER packages_line_total
  AFTER UPDATE OF status ON "order".packages
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN ((OLD.status = 'cancelled') IS DISTINCT FROM (NEW.status = 'cancelled'))
  EXECUTE FUNCTION "order".check_package_status_line_total();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER order_lines_line_total
  AFTER UPDATE OF quantity, cancelled_qty ON "order".order_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.quantity IS DISTINCT FROM NEW.quantity OR OLD.cancelled_qty IS DISTINCT FROM NEW.cancelled_qty)
  EXECUTE FUNCTION "order".check_order_line_total();
