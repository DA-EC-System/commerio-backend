CREATE TYPE "channel"."shop_product_origin" AS ENUM('app', 'match');--> statement-breakpoint
CREATE TYPE "channel"."shop_product_status" AS ENUM('active', 'delisted', 'failed');--> statement-breakpoint
CREATE TABLE "channel"."shop_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"product_id" uuid,
	"external_product_id" text,
	"origin" "channel"."shop_product_origin" NOT NULL,
	"status" "channel"."shop_product_status" DEFAULT 'active' NOT NULL,
	"push_error" jsonb,
	"push_started_at" timestamp with time zone,
	"create_attempted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "shop_products_id_external_uq" UNIQUE("id","external_product_id"),
	CONSTRAINT "shop_products_origin" CHECK (("channel"."shop_products"."origin" = 'app') = ("channel"."shop_products"."product_id" is not null)),
	CONSTRAINT "shop_products_match_external" CHECK ("channel"."shop_products"."origin" = 'app' or "channel"."shop_products"."external_product_id" is not null),
	CONSTRAINT "shop_products_failed" CHECK ("channel"."shop_products"."status" <> 'failed' or ("channel"."shop_products"."origin" = 'app' and "channel"."shop_products"."external_product_id" is null and "channel"."shop_products"."push_error" is not null))
);
--> statement-breakpoint
CREATE TABLE "channel"."spec_field_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"platform" "channel"."marketplace" NOT NULL,
	"attribute_code" text NOT NULL,
	"priority" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spec_field_mappings_code_uq" UNIQUE("company_id","field_id","platform","attribute_code"),
	CONSTRAINT "spec_field_mappings_priority_uq" UNIQUE("company_id","field_id","platform","priority"),
	CONSTRAINT "spec_field_mappings_attribute_uq" UNIQUE("company_id","platform","attribute_code"),
	CONSTRAINT "spec_field_mappings_priority" CHECK ("channel"."spec_field_mappings"."priority" >= 1)
);
--> statement-breakpoint
CREATE TABLE "channel"."spec_option_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"option_id" uuid NOT NULL,
	"platform" "channel"."marketplace" NOT NULL,
	"attribute_code" text NOT NULL,
	"platform_option_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spec_option_mappings_uq" UNIQUE("company_id","option_id","platform","attribute_code")
);
--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD COLUMN "shop_product_id" uuid;--> statement-breakpoint
ALTER TABLE "channel"."shop_products" ADD CONSTRAINT "shop_products_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "channel"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."spec_option_mappings" ADD CONSTRAINT "spec_option_mappings_field_fk" FOREIGN KEY ("company_id","field_id","platform","attribute_code") REFERENCES "channel"."spec_field_mappings"("company_id","field_id","platform","attribute_code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shop_products_shop_external_uq" ON "channel"."shop_products" USING btree ("shop_id","external_product_id") WHERE "channel"."shop_products"."external_product_id" is not null and "channel"."shop_products"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "shop_products_shop_app_product_uq" ON "channel"."shop_products" USING btree ("shop_id","product_id") WHERE "channel"."shop_products"."origin" = 'app' and "channel"."shop_products"."status" = 'active';--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD CONSTRAINT "listings_shop_product_id_shop_products_id_fk" FOREIGN KEY ("shop_product_id") REFERENCES "channel"."shop_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD CONSTRAINT "listings_shop_product_external_fk" FOREIGN KEY ("shop_product_id","external_product_id") REFERENCES "channel"."shop_products"("id","external_product_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listings_shop_product_id_index" ON "channel"."listings" USING btree ("shop_product_id");