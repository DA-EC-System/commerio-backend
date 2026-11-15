ALTER TABLE "order"."packages" ADD COLUMN "delivery_posted_at" timestamp with time zone;--> statement-breakpoint
-- Kiện đã giao trước 199c: coi như đã báo, không phát bù sự kiện cho dữ liệu cũ (spec 199c §5.1).
UPDATE "order"."packages" SET "delivery_posted_at" = "delivered_at"
  WHERE "status" = 'delivered' AND "delivered_at" IS NOT NULL;