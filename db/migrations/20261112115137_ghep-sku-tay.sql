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
ALTER TABLE "channel"."listings" DROP CONSTRAINT "listings_unmanaged_approved";--> statement-breakpoint
ALTER TABLE "channel"."shops" DROP CONSTRAINT "shops_setup_mode";--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD COLUMN "pending_variant_id" uuid;--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD COLUMN "pending_mode" "channel"."listing_mode";--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD COLUMN "pending_requested_by" uuid;--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD COLUMN "pending_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD COLUMN "mapping_self_approved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD COLUMN "mapping_requested_by" uuid;--> statement-breakpoint
ALTER TABLE "channel"."shops" ADD COLUMN "remote_skus_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel"."shops" ADD COLUMN "remote_skus_changed_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel"."shops" ADD COLUMN "remote_skus_full_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "channel"."shops" ADD COLUMN "remote_skus_full_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel"."shops" ADD COLUMN "remote_skus_full_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel"."remote_skus" ADD CONSTRAINT "remote_skus_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "channel"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "remote_skus_shop_external_sku_uq" ON "channel"."remote_skus" USING btree ("shop_id","external_sku_id");--> statement-breakpoint
CREATE INDEX "raw_orders_lines_gin" ON "channel"."raw_orders" USING gin (("payload" -> 'lines') jsonb_path_ops);--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD CONSTRAINT "listings_pending_mapping" CHECK (("channel"."listings"."pending_mode" is null and "channel"."listings"."pending_variant_id" is null and "channel"."listings"."pending_requested_by" is null and "channel"."listings"."pending_requested_at" is null)
        or ("channel"."listings"."pending_requested_by" is not null and "channel"."listings"."pending_requested_at" is not null and "channel"."listings"."pending_mode" is not null and ("channel"."listings"."pending_mode" = 'mapped') = ("channel"."listings"."pending_variant_id" is not null)));--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD CONSTRAINT "listings_delisted_no_pending" CHECK ("channel"."listings"."status" <> 'delisted' or "channel"."listings"."pending_requested_by" is null);--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD CONSTRAINT "listings_self_approved_has_approver" CHECK (not "channel"."listings"."mapping_self_approved" or "channel"."listings"."approved_by" is not null);--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD CONSTRAINT "listings_mapping_second_person" CHECK ("channel"."listings"."approved_by" is null or "channel"."listings"."mapping_requested_by" is null or "channel"."listings"."approved_by" <> "channel"."listings"."mapping_requested_by" or "channel"."listings"."mapping_self_approved");--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD CONSTRAINT "listings_unmanaged_approved" CHECK ("channel"."listings"."mode" = 'mapped' or "channel"."listings"."approved_by" is not null or "channel"."listings"."pending_requested_by" is not null);--> statement-breakpoint
ALTER TABLE "channel"."shops" ADD CONSTRAINT "shops_remote_skus_retry" CHECK ("channel"."shops"."remote_skus_full_failures" >= 0 and ("channel"."shops"."remote_skus_full_failures" = 0) = ("channel"."shops"."remote_skus_full_retry_at" is null));--> statement-breakpoint
ALTER TABLE "channel"."shops" ADD CONSTRAINT "shops_remote_skus_failed_at" CHECK ("channel"."shops"."remote_skus_full_failures" = 0 or "channel"."shops"."remote_skus_full_failed_at" is not null);--> statement-breakpoint
ALTER TABLE "channel"."shops" ADD CONSTRAINT "shops_setup_mode" CHECK ("channel"."shops"."opening_stock_mode" is null or "channel"."shops"."opening_stock_mode" in ('push', 'stocktake'));