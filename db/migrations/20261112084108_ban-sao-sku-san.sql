CREATE TABLE "channel"."remote_skus" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"external_product_id" text NOT NULL,
	"external_sku_id" text NOT NULL,
	"seller_sku" text NOT NULL,
	"title" text NOT NULL,
	"state" text NOT NULL,
	"quantity" integer NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "remote_skus_state" CHECK ("channel"."remote_skus"."state" in ('review', 'live', 'rejected', 'hold', 'inactive')),
	CONSTRAINT "remote_skus_quantity" CHECK ("channel"."remote_skus"."quantity" >= 0)
);
--> statement-breakpoint
ALTER TABLE "channel"."shops" DROP CONSTRAINT "shops_setup_mode";--> statement-breakpoint
ALTER TABLE "channel"."shops" ADD COLUMN "remote_skus_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel"."shops" ADD COLUMN "remote_skus_changed_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel"."remote_skus" ADD CONSTRAINT "remote_skus_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "channel"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "remote_skus_shop_external_sku_uq" ON "channel"."remote_skus" USING btree ("shop_id","external_sku_id");--> statement-breakpoint
CREATE INDEX "raw_orders_lines_gin" ON "channel"."raw_orders" USING gin (("payload" -> 'lines') jsonb_path_ops);--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD CONSTRAINT "listings_delisted_no_pending" CHECK ("channel"."listings"."status" <> 'delisted' or "channel"."listings"."pending_requested_by" is null);--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD CONSTRAINT "listings_self_approved_has_approver" CHECK (not "channel"."listings"."mapping_self_approved" or "channel"."listings"."approved_by" is not null);--> statement-breakpoint
ALTER TABLE "channel"."shops" ADD CONSTRAINT "shops_setup_mode" CHECK ("channel"."shops"."opening_stock_mode" is null or "channel"."shops"."opening_stock_mode" in ('push', 'stocktake'));