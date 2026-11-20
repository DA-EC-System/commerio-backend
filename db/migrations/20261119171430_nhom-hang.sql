CREATE TABLE "product"."company_product_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"sku_pattern" text DEFAULT 'SP{SEQ:5}-{VAL}' NOT NULL,
	"sku_next_seq" integer DEFAULT 1 NOT NULL,
	"margin_coefficient" numeric(18, 2),
	"price_rounding" integer,
	"reorder_lead_days" integer,
	"reorder_safety_qty" integer,
	"reorder_default_qty" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "company_product_settings_sku_next_seq" CHECK ("product"."company_product_settings"."sku_next_seq" >= 1),
	CONSTRAINT "company_product_settings_margin_coefficient" CHECK ("product"."company_product_settings"."margin_coefficient" >= 1),
	CONSTRAINT "company_product_settings_price_rounding" CHECK ("product"."company_product_settings"."price_rounding" > 0),
	CONSTRAINT "company_product_settings_reorder_config" CHECK ("product"."company_product_settings"."reorder_lead_days" >= 0 and "product"."company_product_settings"."reorder_safety_qty" >= 0 and "product"."company_product_settings"."reorder_default_qty" >= 0)
);
--> statement-breakpoint
ALTER TABLE "product"."categories" RENAME TO "product_groups";--> statement-breakpoint
ALTER TABLE "product"."products" RENAME COLUMN "category_id" TO "group_id";--> statement-breakpoint
ALTER TABLE "product"."purchase_request_lines" RENAME COLUMN "new_category_id" TO "new_group_id";--> statement-breakpoint
ALTER TABLE "product"."product_groups" DROP CONSTRAINT "categories_margin_coefficient";--> statement-breakpoint
ALTER TABLE "product"."product_groups" DROP CONSTRAINT "categories_price_rounding";--> statement-breakpoint
ALTER TABLE "product"."product_groups" DROP CONSTRAINT "categories_reorder_config";--> statement-breakpoint
ALTER TABLE "product"."products" DROP CONSTRAINT "products_category_id_categories_id_fk";
--> statement-breakpoint
DROP INDEX "product"."categories_company_lower_name_uq";--> statement-breakpoint
DROP INDEX "product"."products_category_id_index";--> statement-breakpoint
ALTER TABLE "product"."attributes" ADD COLUMN "platform_kind" text;--> statement-breakpoint
ALTER TABLE "product"."products" ADD CONSTRAINT "products_group_id_product_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "product"."product_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attributes_company_platform_kind_uq" ON "product"."attributes" USING btree ("company_id","platform_kind") WHERE "product"."attributes"."platform_kind" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "product_groups_company_lower_name_uq" ON "product"."product_groups" USING btree ("company_id",lower("name"));--> statement-breakpoint
CREATE INDEX "products_group_id_index" ON "product"."products" USING btree ("group_id");--> statement-breakpoint
ALTER TABLE "product"."product_groups" DROP COLUMN "sku_pattern";--> statement-breakpoint
ALTER TABLE "product"."product_groups" DROP COLUMN "sku_next_seq";--> statement-breakpoint
ALTER TABLE "product"."attribute_values" ADD CONSTRAINT "attribute_values_value_length" CHECK (char_length("product"."attribute_values"."value") <= 20);--> statement-breakpoint
ALTER TABLE "product"."attributes" ADD CONSTRAINT "attributes_platform_kind" CHECK ("product"."attributes"."platform_kind" in ('color', 'size'));--> statement-breakpoint
ALTER TABLE "product"."attributes" ADD CONSTRAINT "attributes_name_length" CHECK (char_length("product"."attributes"."name") <= 15);--> statement-breakpoint
ALTER TABLE "product"."product_groups" ADD CONSTRAINT "product_groups_margin_coefficient" CHECK ("product"."product_groups"."margin_coefficient" >= 1);--> statement-breakpoint
ALTER TABLE "product"."product_groups" ADD CONSTRAINT "product_groups_price_rounding" CHECK ("product"."product_groups"."price_rounding" > 0);--> statement-breakpoint
ALTER TABLE "product"."product_groups" ADD CONSTRAINT "product_groups_reorder_config" CHECK ("product"."product_groups"."reorder_lead_days" >= 0 and "product"."product_groups"."reorder_safety_qty" >= 0 and "product"."product_groups"."reorder_default_qty" >= 0);--> statement-breakpoint
ALTER TABLE "product"."product_variants" ADD CONSTRAINT "product_variants_sku_length" CHECK (char_length("product"."product_variants"."sku") <= 50);