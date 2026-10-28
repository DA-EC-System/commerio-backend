CREATE TABLE "channel"."category_maps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"platform" "channel"."marketplace" NOT NULL,
	"category_id" uuid NOT NULL,
	"external_category_id" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "category_maps_company_id_platform_category_id_unique" UNIQUE("company_id","platform","category_id")
);
--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD COLUMN "stock_sync_error" jsonb;--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD COLUMN "price_sync_error" jsonb;--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD COLUMN "last_pushed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD COLUMN "external_image_urls" text[];