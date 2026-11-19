-- Dọn cờ Đang huỷ kẹt (test đêm 18/11/2026: DH-B03, KH-B09), viết tay, chỉ dữ liệu, chạy lại được. Chạy trước migration
-- đổi `cancelling` thành `cancel_pending` và thêm CHECK `orders_cancel_pending_open`, `orders_cancel_requested_open`
-- (cùng một giao dịch), nên còn dùng tên cột cũ.
-- 1. Đơn đã dừng (`completed`, `cancelled`) không còn chờ sàn trả lời lệnh huỷ hay khách xin huỷ.
update "order".orders set cancelling = false
where cancelling and status not in ('unpaid', 'processing');
--> statement-breakpoint
update "order".orders set cancel_requested = false
where cancel_requested and status not in ('unpaid', 'processing');
--> statement-breakpoint
-- 2. Đơn có món sàn đã huỷ: sàn đã trả lời. Phần còn chờ kho mở kiện do cờ suy ra (kiện `needs_open`) giữ.
update "order".orders o set cancelling = false
where o.cancelling
  and exists (select 1 from "order".order_lines l where l.order_id = o.id and l.cancelled_qty > 0);
--> statement-breakpoint
-- 3. Tiền của đơn huỷ một phần món: chỉ gồm dòng chưa huỷ hết, phí ship giữ nguyên; đơn huỷ hết món giữ tiền lúc đặt.
with s as (
  select l.order_id,
         coalesce(sum(l.unit_price * (l.quantity - l.cancelled_qty)), 0)::numeric(18, 2) as subtotal,
         coalesce(sum(l.seller_discount) filter (where l.cancelled_qty < l.quantity), 0)::numeric(18, 2) as seller_discount,
         coalesce(sum(l.platform_discount) filter (where l.cancelled_qty < l.quantity), 0)::numeric(18, 2) as platform_discount
  from "order".order_lines l
  group by l.order_id
  having bool_or(l.cancelled_qty < l.quantity) and bool_or(l.cancelled_qty > 0)
)
update "order".orders o
set subtotal = s.subtotal, seller_discount = s.seller_discount, platform_discount = s.platform_discount,
    total = greatest(0, s.subtotal - s.seller_discount - s.platform_discount + o.shipping_fee),
    version = o.version + 1, updated_at = now()
from s
where o.id = s.order_id
  and (o.subtotal, o.seller_discount, o.platform_discount) is distinct from (s.subtotal, s.seller_discount, s.platform_discount);
