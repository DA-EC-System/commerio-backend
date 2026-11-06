-- #198. `pg_trgm` cho gợi ý ghép theo tên ở thiết lập gian hàng (Documents/21 §18.7.5, `similarity()`). Extension "trusted"
-- từ PostgreSQL 13: role có quyền CREATE trên database tạo được (staging Supabase chạy migration bằng `postgres`, test
-- bằng `commerio_migrator`). Không ghi schema: rơi vào `public` như `vector`, `btree_gist` (0000).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
-- Gian hàng đã thiết lập trước #198 đã kéo đơn, đẩy tồn như cũ: đánh dấu xong hai bước để hành vi không đổi (#198 A10).
UPDATE "channel"."shops" SET "open_orders_pulled_at" = now(), "stock_pushed_at" = now() WHERE "order_cutoff_at" IS NOT NULL;
