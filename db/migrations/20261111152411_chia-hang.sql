ALTER TABLE "order"."packages" ADD COLUMN "reserved_at" timestamp with time zone;--> statement-breakpoint
-- Kiện đang giữ hàng có từ trước 199b: lấy lúc lập kiện làm lúc giữ (xấp xỉ, spec 199b §5.1).
UPDATE "order"."packages" p SET "reserved_at" = p."created_at"
  WHERE p."status" IN ('reserved','packed','awaiting_pickup')
    AND EXISTS (SELECT 1 FROM "order"."package_lines" l WHERE l."package_id" = p."id" AND l."reserved_qty" > 0);
