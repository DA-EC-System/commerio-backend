ALTER TABLE "channel"."shops" ADD COLUMN "opening_stocktake_id" uuid;--> statement-breakpoint
ALTER TABLE "channel"."shops" ADD COLUMN "opening_stocktake_number" text;--> statement-breakpoint
ALTER TABLE "channel"."shops" ADD COLUMN "opening_stock_mode" text;--> statement-breakpoint
ALTER TABLE "channel"."shops" ADD COLUMN "unmatched_sku_count" integer;--> statement-breakpoint
ALTER TABLE "channel"."shops" ADD COLUMN "open_orders_pulled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel"."shops" ADD COLUMN "stock_pushed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order"."packages" ADD COLUMN "notices" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "shops_one_opening_stocktake_uq" ON "channel"."shops" USING btree ("company_id") WHERE "channel"."shops"."opening_stocktake_id" is not null;--> statement-breakpoint
ALTER TABLE "channel"."shops" ADD CONSTRAINT "shops_opening_stocktake" CHECK (("channel"."shops"."opening_stocktake_id" is null) = ("channel"."shops"."opening_stocktake_number" is null) and ("channel"."shops"."opening_stocktake_id" is null or "channel"."shops"."order_cutoff_at" is not null));--> statement-breakpoint
ALTER TABLE "channel"."shops" ADD CONSTRAINT "shops_setup_mode" CHECK (("channel"."shops"."opening_stock_mode" is null) = ("channel"."shops"."unmatched_sku_count" is null) and ("channel"."shops"."opening_stock_mode" is null or "channel"."shops"."opening_stock_mode" in ('push', 'stocktake')));