DROP INDEX "channel"."listings_shop_variant_uq";--> statement-breakpoint
DROP INDEX "channel"."listings_shop_external_sku_uq";--> statement-breakpoint
ALTER TABLE "channel"."listings" ALTER COLUMN "push_error" SET DATA TYPE jsonb;--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD COLUMN "replaces_listing_id" uuid;--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD CONSTRAINT "listings_replaces_listing_id_listings_id_fk" FOREIGN KEY ("replaces_listing_id") REFERENCES "channel"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "listings_shop_variant_uq" ON "channel"."listings" USING btree ("shop_id","variant_id") WHERE "channel"."listings"."variant_id" is not null and "channel"."listings"."status" <> 'delisted';--> statement-breakpoint
CREATE UNIQUE INDEX "listings_shop_external_sku_uq" ON "channel"."listings" USING btree ("shop_id","external_sku_id") WHERE "channel"."listings"."external_sku_id" is not null and "channel"."listings"."status" <> 'delisted';