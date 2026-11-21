CREATE TABLE "product"."company_group_settings" (
	"company_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"margin_coefficient" numeric(18, 2),
	"price_rounding" integer,
	"reorder_lead_days" integer,
	"reorder_safety_qty" integer,
	"reorder_default_qty" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "company_group_settings_company_id_group_id_pk" PRIMARY KEY("company_id","group_id"),
	CONSTRAINT "company_group_settings_margin_coefficient" CHECK ("product"."company_group_settings"."margin_coefficient" >= 1),
	CONSTRAINT "company_group_settings_price_rounding" CHECK ("product"."company_group_settings"."price_rounding" > 0),
	CONSTRAINT "company_group_settings_reorder_config" CHECK ("product"."company_group_settings"."reorder_lead_days" >= 0 and "product"."company_group_settings"."reorder_safety_qty" >= 0 and "product"."company_group_settings"."reorder_default_qty" >= 0)
);
--> statement-breakpoint
ALTER TABLE "product"."attribute_values" DROP CONSTRAINT "attribute_values_attribute_id_code_unique";--> statement-breakpoint
ALTER TABLE "product"."spec_fields" DROP CONSTRAINT "spec_fields_company_code_uq";--> statement-breakpoint
DROP INDEX "product"."attribute_values_attribute_lower_value_uq";--> statement-breakpoint
DROP INDEX "product"."attributes_company_platform_kind_uq";--> statement-breakpoint
DROP INDEX "product"."spec_field_options_field_lower_value_uq";--> statement-breakpoint
DROP INDEX "product"."attributes_company_lower_name_uq";--> statement-breakpoint
DROP INDEX "product"."product_groups_company_lower_name_uq";--> statement-breakpoint
DROP INDEX "product"."spec_fields_company_lower_name_uq";--> statement-breakpoint
ALTER TABLE "product"."group_spec_fields" DROP CONSTRAINT "group_spec_fields_group_id_field_id_pk";--> statement-breakpoint
ALTER TABLE "product"."attribute_values" ALTER COLUMN "company_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "product"."attributes" ALTER COLUMN "company_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "product"."group_spec_fields" ALTER COLUMN "company_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "product"."product_groups" ALTER COLUMN "company_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "product"."spec_field_options" ALTER COLUMN "company_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "product"."spec_fields" ALTER COLUMN "company_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "product"."group_spec_fields" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "product"."company_group_settings" ADD CONSTRAINT "company_group_settings_group_id_product_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "product"."product_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_group_settings_group_id_index" ON "product"."company_group_settings" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_values_platform_lower_value_uq" ON "product"."attribute_values" USING btree ("attribute_id",lower("value")) WHERE "product"."attribute_values"."company_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_values_platform_code_uq" ON "product"."attribute_values" USING btree ("attribute_id","code") WHERE "product"."attribute_values"."company_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_values_company_lower_value_uq" ON "product"."attribute_values" USING btree ("company_id","attribute_id",lower("value")) WHERE "product"."attribute_values"."company_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_values_company_code_uq" ON "product"."attribute_values" USING btree ("company_id","attribute_id","code") WHERE "product"."attribute_values"."company_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "attributes_platform_lower_name_uq" ON "product"."attributes" USING btree (lower("name")) WHERE "product"."attributes"."company_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "attributes_platform_kind_uq" ON "product"."attributes" USING btree ("platform_kind") WHERE "product"."attributes"."company_id" is null and "product"."attributes"."platform_kind" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "product_groups_platform_lower_name_uq" ON "product"."product_groups" USING btree (lower("name")) WHERE "product"."product_groups"."company_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "spec_field_options_platform_lower_value_uq" ON "product"."spec_field_options" USING btree ("field_id",lower("value")) WHERE "product"."spec_field_options"."company_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "spec_field_options_company_lower_value_uq" ON "product"."spec_field_options" USING btree ("company_id","field_id",lower("value")) WHERE "product"."spec_field_options"."company_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "spec_fields_platform_code_uq" ON "product"."spec_fields" USING btree ("code") WHERE "product"."spec_fields"."company_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "spec_fields_platform_lower_name_uq" ON "product"."spec_fields" USING btree (lower("name")) WHERE "product"."spec_fields"."company_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "spec_fields_company_code_uq" ON "product"."spec_fields" USING btree ("company_id","code") WHERE "product"."spec_fields"."company_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "attributes_company_lower_name_uq" ON "product"."attributes" USING btree ("company_id",lower("name")) WHERE "product"."attributes"."company_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "product_groups_company_lower_name_uq" ON "product"."product_groups" USING btree ("company_id",lower("name")) WHERE "product"."product_groups"."company_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "spec_fields_company_lower_name_uq" ON "product"."spec_fields" USING btree ("company_id",lower("name")) WHERE "product"."spec_fields"."company_id" is not null;--> statement-breakpoint
ALTER TABLE "product"."group_spec_fields" ADD CONSTRAINT "group_spec_fields_group_field_company_uq" UNIQUE NULLS NOT DISTINCT("group_id","field_id","company_id");