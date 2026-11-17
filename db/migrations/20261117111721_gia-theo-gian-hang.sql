ALTER TABLE "channel"."price_calculations" ALTER COLUMN "cost" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "channel"."price_calculations" ALTER COLUMN "margin_pct" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "channel"."price_calculations" ALTER COLUMN "below_floor" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "channel"."price_calculations" ADD COLUMN "tax_regime_version_id" uuid;--> statement-breakpoint
ALTER TABLE "channel"."price_calculations" ADD COLUMN "min_margin_version_id" uuid;--> statement-breakpoint
ALTER TABLE "channel"."price_calculations" ADD COLUMN "per_item_fee" numeric(18, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "channel"."price_calculations" ADD COLUMN "fee_pct" numeric(5, 2) NOT NULL;--> statement-breakpoint
ALTER TABLE "channel"."price_calculations" ADD COLUMN "tax_pct" numeric(7, 4) NOT NULL;--> statement-breakpoint
ALTER TABLE "channel"."price_calculations" ADD COLUMN "min_margin_pct" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "channel"."price_calculations" ADD COLUMN "trigger" text NOT NULL;--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD CONSTRAINT "listings_price_calc_id_price_calculations_id_fk" FOREIGN KEY ("price_calc_id") REFERENCES "channel"."price_calculations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "price_calculations_one_pending" ON "channel"."price_calculations" USING btree ("shop_id","variant_id") WHERE "channel"."price_calculations"."status" = 'pending_confirm';--> statement-breakpoint
ALTER TABLE "channel"."price_calculations" ADD CONSTRAINT "price_calculations_cost_floor" CHECK (("channel"."price_calculations"."cost" is null) = ("channel"."price_calculations"."below_floor" is null));--> statement-breakpoint
ALTER TABLE "channel"."price_calculations" ADD CONSTRAINT "price_calculations_trigger" CHECK ("channel"."price_calculations"."trigger" in ('push', 'target_changed', 'config_activated'));