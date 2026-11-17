-- Kéo lại đơn có món mang trạng thái app chưa biết lúc kéo (#358; vd Lazada `confirmed` trước khi có ánh xạ). Chỉ đổi
-- dữ liệu, chạy lại được. Dữ liệu gốc (`payload.lines[].status`) null là món adapter chưa ánh xạ: sàn không đổi
-- `updated_at` nên lượt kéo thường không gọi lại chi tiết, kiện kẹt. Không lọc trạng thái đơn (khác `*_huy-dong-du-lieu`):
-- đơn đã hoàn tất kéo lại cũng vô hại và gỡ được cờ "Sàn trả trạng thái app chưa biết". Cập nhật `shops` trước
-- `raw_orders`, cùng thứ tự khoá với lượt kéo đơn. `external_update_time` đặt `epoch`, không NULL (lý do ở
-- `*_huy-dong-du-lieu`). Worker cũ còn chạy lúc đổi image thì **phải** chạy lại hai câu này sau rollout. Còn món lạ thật
-- (adapter mới vẫn trả null) thì lần chạy lại chọn lại đơn đó: vô hại, lượt sau chỉ gọi chi tiết đơn `epoch`.
UPDATE channel.shops SET last_order_sync_at = NULL
WHERE id IN (SELECT r.shop_id FROM channel.raw_orders r WHERE r.payload -> 'lines' @> '[{"status": null}]');
--> statement-breakpoint
UPDATE channel.raw_orders SET external_update_time = 'epoch'
WHERE payload -> 'lines' @> '[{"status": null}]';
