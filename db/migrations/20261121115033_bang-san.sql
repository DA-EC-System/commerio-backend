CREATE TYPE "order"."contact_channel" AS ENUM('marketplace', 'messenger', 'email', 'zalo_oa');--> statement-breakpoint
CREATE TABLE "channel"."marketplaces" (
	"code" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order"."customer_identities" DROP CONSTRAINT "customer_identities_company_id_channel_kind_external_user_id_unique";--> statement-breakpoint
ALTER TABLE "channel"."platform_category_attributes" DROP CONSTRAINT "platform_category_attributes_category_fk";
--> statement-breakpoint
ALTER TABLE "channel"."api_usage" ALTER COLUMN "platform" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "channel"."axis_mappings" ALTER COLUMN "platform" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "channel"."platform_categories" ALTER COLUMN "platform" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "channel"."platform_category_attributes" ALTER COLUMN "platform" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "channel"."product_specs" ALTER COLUMN "platform" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "channel"."shops" ALTER COLUMN "platform" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "channel"."spec_field_mappings" ALTER COLUMN "platform" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "channel"."spec_option_mappings" ALTER COLUMN "platform" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "channel"."webhook_events" ALTER COLUMN "platform" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "order"."customer_identities" ADD COLUMN "source" "order"."contact_channel" NOT NULL;--> statement-breakpoint
ALTER TABLE "order"."customer_identities" ADD COLUMN "platform" text;--> statement-breakpoint
ALTER TABLE "order"."customer_identities" DROP COLUMN "channel_kind";--> statement-breakpoint
ALTER TABLE "order"."customer_identities" ADD CONSTRAINT "customer_identities_uq" UNIQUE NULLS NOT DISTINCT("company_id","source","platform","external_user_id");--> statement-breakpoint
ALTER TABLE "order"."customer_identities" ADD CONSTRAINT "customer_identities_platform" CHECK (("order"."customer_identities"."source" = 'marketplace') = ("order"."customer_identities"."platform" IS NOT NULL));--> statement-breakpoint
DROP TYPE "channel"."marketplace";--> statement-breakpoint
DROP TYPE "order"."channel_kind";