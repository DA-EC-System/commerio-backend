-- Bỏ trigger, hàm giữ cột cờ cũ `cancelling` bằng `cancel_pending` (#417 bước một); dọn hai cờ chờ sàn của đơn đã dừng trước CHECK (#427), viết tay, chạy lại được.
drop trigger if exists orders_sync_cancel_pending on "order".orders;
--> statement-breakpoint
drop function if exists "order".orders_sync_cancel_pending();
--> statement-breakpoint
update "order".orders set cancel_pending = false, cancel_requested = false
where (cancel_pending or cancel_requested) and status not in ('unpaid', 'processing');
