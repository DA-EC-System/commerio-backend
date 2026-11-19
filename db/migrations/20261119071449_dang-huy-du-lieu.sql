-- Dọn cờ Đang huỷ kẹt (test đêm 18/11/2026: DH-B03, KH-B09), viết tay, chỉ dữ liệu, chạy lại được. Chạy trước migration
-- thêm cột `cancel_pending` và CHECK `orders_cancel_pending_open`, `orders_cancel_requested_open` (cùng một giao dịch),
-- nên chỉ dọn cột cờ cũ `cancelling`; `*_dang-huy-chuyen-co` chép phần còn lại sang `cancel_pending`.
-- 1. Đơn đã dừng (`completed`, `cancelled`) không còn chờ sàn trả lời lệnh huỷ hay khách xin huỷ.
update "order".orders set cancelling = false
where cancelling and status not in ('unpaid', 'processing');
--> statement-breakpoint
update "order".orders set cancel_requested = false
where cancel_requested and status not in ('unpaid', 'processing');
--> statement-breakpoint
-- 2. Sàn đã trả lời: có món đã huỷ, hay sàn đã huỷ mọi món khi có kiện đã rời kho (cờ Sàn đã huỷ; dòng của kiện đó giữ
-- `cancelled_qty = 0`). Phần còn chờ kho mở kiện do cờ suy ra giữ. Dữ liệu cũ không phân biệt được lệnh huỷ cả đơn mà
-- sàn mới huỷ một phần món với yêu cầu huỷ một món đã xong (KH-B09), nên cả hai đều bỏ cờ.
update "order".orders o set cancelling = false
where o.cancelling
  and (o.platform_cancelled or exists (select 1 from "order".order_lines l where l.order_id = o.id and l.cancelled_qty > 0));
--> statement-breakpoint
-- 3. Tiền của đơn còn mở có món đã huỷ, như `recomputeTotals`: còn món chưa huỷ thì chỉ gồm dòng chưa huỷ hết, mọi món đã
-- huỷ thì theo mọi món; phí ship giữ nguyên. Đơn đã dừng không sửa: có thể đã đối soát với `orders.total`
-- (`settlement-match.ts`, `payment/service/boundary.ts`).
with s as (
  select l.order_id,
         (case when bool_and(l.cancelled_qty = l.quantity) then sum(l.unit_price * l.quantity)
               else sum(l.unit_price * (l.quantity - l.cancelled_qty)) end)::numeric(18, 2) as subtotal,
         (case when bool_and(l.cancelled_qty = l.quantity) then sum(l.seller_discount)
               else coalesce(sum(l.seller_discount) filter (where l.cancelled_qty < l.quantity), 0) end)::numeric(18, 2) as seller_discount,
         (case when bool_and(l.cancelled_qty = l.quantity) then sum(l.platform_discount)
               else coalesce(sum(l.platform_discount) filter (where l.cancelled_qty < l.quantity), 0) end)::numeric(18, 2) as platform_discount
  from "order".order_lines l
  group by l.order_id
  having bool_or(l.cancelled_qty > 0)
)
update "order".orders o
set subtotal = s.subtotal, seller_discount = s.seller_discount, platform_discount = s.platform_discount,
    total = greatest(0, s.subtotal - s.seller_discount - s.platform_discount + o.shipping_fee),
    version = o.version + 1, updated_at = now()
from s
where o.id = s.order_id
  and o.status in ('unpaid', 'processing')
  and (o.subtotal, o.seller_discount, o.platform_discount) is distinct from (s.subtotal, s.seller_discount, s.platform_discount);
