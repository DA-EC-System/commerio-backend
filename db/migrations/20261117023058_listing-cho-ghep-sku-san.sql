ALTER TABLE "channel"."listings" ADD COLUMN "pending_external_sku_id" text;--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD COLUMN "pending_external_product_id" text;--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD COLUMN "pending_seller_sku" text;--> statement-breakpoint
CREATE UNIQUE INDEX "listings_shop_pending_external_sku_uq" ON "channel"."listings" USING btree ("shop_id","pending_external_sku_id") WHERE "channel"."listings"."pending_external_sku_id" is not null;--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD CONSTRAINT "listings_pending_external" CHECK (("channel"."listings"."pending_external_sku_id" is null and "channel"."listings"."pending_external_product_id" is null and "channel"."listings"."pending_seller_sku" is null)
        or ("channel"."listings"."pending_external_sku_id" is not null and "channel"."listings"."pending_external_product_id" is not null and "channel"."listings"."pending_seller_sku" is not null
          and "channel"."listings"."pending_requested_by" is not null and "channel"."listings"."status" = 'push_failed' and "channel"."listings"."external_sku_id" is null));