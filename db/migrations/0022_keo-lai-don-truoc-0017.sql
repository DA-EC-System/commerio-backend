-- Kéo lại một lần các đơn sàn lưu trước #260 (review PR #261 điểm 1, 5). Chỉ đổi dữ liệu, không đổi schema.
-- Đơn cần kéo lại: dữ liệu gốc không có khoá `info` (adapter từ #260 luôn ghi, adapter cũ không có, nên các cột 0017
-- còn null), hoặc địa chỉ còn lặp phường ở cuối `address` (adapter #260 trước bản sửa nối cả `city`).
-- Xoá mốc kéo của gian hàng (lượt sau tính lại từ `order_cutoff_at`) vì sàn chỉ liệt kê đơn đổi sau mốc, rồi xoá
-- `external_update_time` để lượt kéo không bỏ qua đơn. Cập nhật `shops` trước `raw_orders`, cùng thứ tự khoá với
-- lượt kéo đơn. Chạy lại bao nhiêu lần cũng được: worker cũ còn chạy trong lúc đổi image thì chạy lại câu này sau
-- khi rollout xong (bước trong mô tả PR).
UPDATE channel.shops SET last_order_sync_at = NULL
WHERE id IN (
  SELECT r.shop_id FROM channel.raw_orders r
  WHERE NOT (r.payload ? 'info')
     OR (
       r.payload -> 'shippingAddress' ->> 'ward' IS NOT NULL
       AND (
         rtrim(r.payload -> 'shippingAddress' ->> 'address') = r.payload -> 'shippingAddress' ->> 'ward'
         OR right(rtrim(r.payload -> 'shippingAddress' ->> 'address'), length(r.payload -> 'shippingAddress' ->> 'ward') + 2)
            = ', ' || (r.payload -> 'shippingAddress' ->> 'ward')
       )
     )
);--> statement-breakpoint
UPDATE channel.raw_orders r SET external_update_time = NULL
WHERE NOT (r.payload ? 'info')
   OR (
     r.payload -> 'shippingAddress' ->> 'ward' IS NOT NULL
     AND (
       rtrim(r.payload -> 'shippingAddress' ->> 'address') = r.payload -> 'shippingAddress' ->> 'ward'
       OR right(rtrim(r.payload -> 'shippingAddress' ->> 'address'), length(r.payload -> 'shippingAddress' ->> 'ward') + 2)
          = ', ' || (r.payload -> 'shippingAddress' ->> 'ward')
     )
   );
