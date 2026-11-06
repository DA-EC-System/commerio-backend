ALTER TABLE "product"."stock_documents" ADD COLUMN "source_number" text;--> statement-breakpoint
ALTER TABLE "product"."stock_documents" ADD COLUMN "order_id" uuid;--> statement-breakpoint
ALTER TABLE "product"."stock_documents" ADD COLUMN "shop_id" uuid;