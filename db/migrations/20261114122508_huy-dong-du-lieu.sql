-- Dữ liệu cũ cho huỷ dòng (spec 205 §5.10, D22). Chỉ đổi dữ liệu, chạy lại được. Đứng sau migration trigger kiểm bằng
-- (*_huy-dong-kiem-bang) để câu (1) cũng đi qua trigger: mọi dòng nó sửa đều thoả luật.
-- (1) Dòng đơn chỉ còn nằm trong kiện đã huỷ: số đã huỷ = số lượng.
UPDATE "order".order_lines ol SET cancelled_qty = ol.quantity
WHERE ol.cancelled_qty <> ol.quantity
  AND EXISTS (SELECT 1 FROM "order".package_lines pl WHERE pl.order_line_id = ol.id)
  AND NOT EXISTS (
    SELECT 1 FROM "order".package_lines pl JOIN "order".packages p ON p.id = pl.package_id
    WHERE pl.order_line_id = ol.id AND p.status <> 'cancelled'
  );
--> statement-breakpoint
-- (2) Đơn còn mở mà dữ liệu gốc (đơn đã chuẩn hoá, `lines[].status`) có món sàn đã huỷ: kéo lại để áp luật huỷ dòng.
-- Cập nhật `shops` trước `raw_orders`, cùng thứ tự khoá với lượt kéo đơn (như 0022). Worker cũ còn chạy lúc đổi image
-- thì chạy lại hai câu này sau rollout.
UPDATE channel.shops SET last_order_sync_at = NULL
WHERE id IN (
  SELECT r.shop_id FROM channel.raw_orders r JOIN "order".orders o ON o.id = r.order_id
  WHERE o.status IN ('unpaid', 'processing') AND r.payload -> 'lines' @> '[{"status": "cancelled"}]'
);
--> statement-breakpoint
UPDATE channel.raw_orders r SET external_update_time = NULL
FROM "order".orders o
WHERE o.id = r.order_id AND o.status IN ('unpaid', 'processing') AND r.payload -> 'lines' @> '[{"status": "cancelled"}]';
