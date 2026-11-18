-- Hạn bàn giao của kiện theo đơn (KH-B01, ca test đêm 18/11/2026). Kiện đơn sàn chưa bàn giao (`backordered`, `reserved`,
-- `packed`, `awaiting_pickup`) mang đúng `ship_by` của đơn; kiện đã rời kho hay đã huỷ giữ hạn cũ. Trước đây kiện chỉ
-- nhận hạn lúc lập: đơn TikTok về ở ON_HOLD chưa có `rts_sla_time` nên kiện null mãi (hàng chờ không xếp theo hạn, không
-- tô sắp trễ); lượt kéo sàn trả null còn xoá hạn đã lưu của đơn (Documents/21 §19.1: giữ giá trị đã lưu).
--
-- Dữ liệu trước, ràng buộc sau (câu UPDATE chạy lúc chưa có trigger nên không bị kiểm). Mọi câu chỉ ghi dòng còn khác nên
-- chạy lại được; dòng đổi thật thì tăng `version` như lượt kéo.
--
-- 1. Đơn sàn bị lượt kéo cũ xoá hạn (đơn null, còn kiện chưa bàn giao mang hạn): lấy lại hạn của kiện lập sau cùng, là
--    hạn sàn trả gần nhất trước khi bị xoá; code mới sẽ giữ giá trị này khi sàn trả null.
UPDATE "order".orders o
   SET ship_by = k.ship_by, version = o.version + 1, updated_at = now()
  FROM (
    SELECT DISTINCT ON (p.order_id) p.order_id, p.ship_by
      FROM "order".packages p
     WHERE p.status IN ('backordered', 'reserved', 'packed', 'awaiting_pickup') AND p.ship_by IS NOT NULL
     ORDER BY p.order_id, p.created_at DESC, p.code DESC
  ) k
 WHERE k.order_id = o.id AND o.source = 'marketplace' AND o.ship_by IS NULL;
--> statement-breakpoint
-- 2. Kiện chưa bàn giao của đơn sàn nhận hạn của đơn (kể cả kiện tách, kiện thay khi sàn chia lại).
UPDATE "order".packages p
   SET ship_by = o.ship_by, version = p.version + 1, updated_at = now()
  FROM "order".orders o
 WHERE o.id = p.order_id AND o.source = 'marketplace' AND o.ship_by IS NOT NULL
   AND p.status IN ('backordered', 'reserved', 'packed', 'awaiting_pickup')
   AND p.ship_by IS DISTINCT FROM o.ship_by;
--> statement-breakpoint
-- 3. Kiện đã rời kho hay đã huỷ chưa từng có hạn: điền hạn của đơn cho đủ thông tin; kiện đã có hạn giữ nguyên.
UPDATE "order".packages p
   SET ship_by = o.ship_by, version = p.version + 1, updated_at = now()
  FROM "order".orders o
 WHERE o.id = p.order_id AND o.source = 'marketplace' AND o.ship_by IS NOT NULL
   AND p.status NOT IN ('backordered', 'reserved', 'packed', 'awaiting_pickup')
   AND p.ship_by IS NULL;
--> statement-breakpoint
-- 4. Đơn sàn còn mở vẫn chưa có hạn mà còn kiện chưa bàn giao: kéo lại một lần để lấy hạn sàn trả bây giờ (đơn TikTok đã
--    qua ON_HOLD nhưng sàn không đổi `update_time`). Cách đánh dấu như `*_keo-lai-don-trang-thai-moi`: `shops` trước
--    `raw_orders` (cùng thứ tự khoá với lượt kéo), `external_update_time = 'epoch'` (không NULL, lý do ở
--    `*_huy-dong-du-lieu`). Worker cũ còn chạy lúc đổi image thì chạy lại hai câu này sau rollout. Sàn vẫn chưa có hạn
--    thì lần chạy lại chọn lại đơn đó: vô hại.
UPDATE channel.shops SET last_order_sync_at = NULL
WHERE id IN (
  SELECT o.shop_id FROM "order".orders o
   WHERE o.source = 'marketplace' AND o.status IN ('unpaid', 'processing') AND o.ship_by IS NULL
     AND EXISTS (SELECT 1 FROM "order".packages p
                  WHERE p.order_id = o.id AND p.status IN ('backordered', 'reserved', 'packed', 'awaiting_pickup'))
);
--> statement-breakpoint
UPDATE channel.raw_orders r SET external_update_time = 'epoch'
  FROM "order".orders o
 WHERE r.order_id = o.id AND o.source = 'marketplace' AND o.status IN ('unpaid', 'processing') AND o.ship_by IS NULL
   AND r.external_update_time IS DISTINCT FROM 'epoch'
   AND EXISTS (SELECT 1 FROM "order".packages p
                WHERE p.order_id = o.id AND p.status IN ('backordered', 'reserved', 'packed', 'awaiting_pickup'));
--> statement-breakpoint
-- 5. Bất biến: kiện đơn sàn chưa bàn giao có `ship_by IS NOT DISTINCT FROM orders.ship_by`. Kiểm lúc commit
--    (DEFERRABLE INITIALLY DEFERRED, như `*_tach-kien-bat-bien`): lượt kéo ghi kiện trước rồi mới ghi đơn trong cùng giao
--    dịch. Hàm đọc dòng hiện tại lúc commit (không dùng NEW), chạy quyền người gọi, không khoá. Lỗi `23514` kèm
--    `constraint = packages_ship_by_order`; muốn báo ngay: `set constraints "order".packages_ship_by_order immediate`.
-- Lùi: DROP TRIGGER packages_ship_by_order ON "order".packages; DROP TRIGGER orders_ship_by_packages ON "order".orders;
--      DROP FUNCTION "order".assert_package_ship_by();
CREATE FUNCTION "order".assert_package_ship_by() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  bad_code text;
BEGIN
  IF TG_TABLE_NAME = 'orders' THEN
    SELECT p.code INTO bad_code
      FROM "order".packages p
      JOIN "order".orders o ON o.id = p.order_id
     WHERE o.id = NEW.id AND o.source = 'marketplace'
       AND p.status IN ('backordered', 'reserved', 'packed', 'awaiting_pickup')
       AND p.ship_by IS DISTINCT FROM o.ship_by
     LIMIT 1;
  ELSE
    SELECT p.code INTO bad_code
      FROM "order".packages p
      JOIN "order".orders o ON o.id = p.order_id
     WHERE p.id = NEW.id AND o.source = 'marketplace'
       AND p.status IN ('backordered', 'reserved', 'packed', 'awaiting_pickup')
       AND p.ship_by IS DISTINCT FROM o.ship_by;
  END IF;
  IF bad_code IS NOT NULL THEN
    RAISE EXCEPTION 'Kiện % chưa bàn giao mang hạn bàn giao khác hạn của đơn', bad_code
      USING ERRCODE = 'check_violation', CONSTRAINT = 'packages_ship_by_order', SCHEMA = 'order', TABLE = 'packages';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER packages_ship_by_order
  AFTER INSERT OR UPDATE OF ship_by, status ON "order".packages
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "order".assert_package_ship_by();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER orders_ship_by_packages
  AFTER UPDATE OF ship_by ON "order".orders
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.ship_by IS DISTINCT FROM NEW.ship_by)
  EXECUTE FUNCTION "order".assert_package_ship_by();
