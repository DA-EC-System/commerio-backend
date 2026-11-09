CREATE TYPE "order"."handover_source" AS ENUM('scan', 'marketplace', 'forced', 'before_cutoff');--> statement-breakpoint
ALTER TABLE "order"."packages" ADD COLUMN "handover_source" "order"."handover_source";--> statement-breakpoint
ALTER TABLE "order"."packages" ADD COLUMN "handover_reverted_by" uuid;--> statement-breakpoint
ALTER TABLE "order"."packages" ADD COLUMN "pickup_confirmed_at" timestamp with time zone;--> statement-breakpoint
-- Viết tay: kiện đã rời kho trước #199 chưa từng qua `ship`, ghi là chỉ lưu để CHECK dưới đây có dữ liệu sạch.
UPDATE "order"."packages" SET "handover_source" = 'before_cutoff' WHERE "status" IN ('in_transit', 'self_delivering', 'delivered', 'delivery_failed', 'returning', 'returned', 'lost') AND "handover_source" IS NULL;--> statement-breakpoint
ALTER TABLE "order"."packages" ADD CONSTRAINT "packages_handover_source" CHECK ("order"."packages"."status" in ('backordered', 'reserved', 'packed', 'awaiting_pickup', 'cancelled') or "order"."packages"."handover_source" is not null);