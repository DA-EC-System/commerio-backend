CREATE TABLE "product"."group_spec_fields" (
	"company_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_spec_fields_group_id_field_id_pk" PRIMARY KEY("group_id","field_id"),
	CONSTRAINT "group_spec_fields_position" CHECK ("product"."group_spec_fields"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "product"."product_spec_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"option_id" uuid,
	"value_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_spec_values_option_uq" UNIQUE("product_id","field_id","option_id"),
	CONSTRAINT "product_spec_values_one_of" CHECK (("product"."product_spec_values"."option_id" is null) <> ("product"."product_spec_values"."value_text" is null)),
	CONSTRAINT "product_spec_values_text_length" CHECK ("product"."product_spec_values"."value_text" is null or char_length("product"."product_spec_values"."value_text") between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE "product"."spec_field_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"value" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "spec_field_options_id_field_uq" UNIQUE("id","field_id"),
	CONSTRAINT "spec_field_options_value_length" CHECK (char_length("product"."spec_field_options"."value") between 1 and 60),
	CONSTRAINT "spec_field_options_position" CHECK ("product"."spec_field_options"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "product"."spec_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"input" text NOT NULL,
	"unit" text,
	"allow_custom" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "spec_fields_company_code_uq" UNIQUE("company_id","code"),
	CONSTRAINT "spec_fields_input" CHECK ("product"."spec_fields"."input" in ('select', 'multiselect', 'text', 'number', 'date')),
	CONSTRAINT "spec_fields_code_format" CHECK ("product"."spec_fields"."code" ~ '^[a-z0-9_]{1,40}$'),
	CONSTRAINT "spec_fields_name_length" CHECK (char_length("product"."spec_fields"."name") between 1 and 40),
	CONSTRAINT "spec_fields_unit" CHECK ("product"."spec_fields"."unit" is null or ("product"."spec_fields"."input" = 'number' and char_length("product"."spec_fields"."unit") between 1 and 10))
);
--> statement-breakpoint
ALTER TABLE "product"."attributes" DROP CONSTRAINT "attributes_platform_kind";--> statement-breakpoint
ALTER TABLE "product"."product_groups" ADD COLUMN "axis1_attribute_id" uuid;--> statement-breakpoint
ALTER TABLE "product"."product_groups" ADD COLUMN "axis2_attribute_id" uuid;--> statement-breakpoint
ALTER TABLE "product"."group_spec_fields" ADD CONSTRAINT "group_spec_fields_group_id_product_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "product"."product_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product"."group_spec_fields" ADD CONSTRAINT "group_spec_fields_field_id_spec_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "product"."spec_fields"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product"."product_spec_values" ADD CONSTRAINT "product_spec_values_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "product"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product"."product_spec_values" ADD CONSTRAINT "product_spec_values_field_id_spec_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "product"."spec_fields"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product"."spec_field_options" ADD CONSTRAINT "spec_field_options_field_id_spec_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "product"."spec_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_spec_fields_field_id_index" ON "product"."group_spec_fields" USING btree ("field_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_spec_values_text_uq" ON "product"."product_spec_values" USING btree ("product_id","field_id") WHERE "product"."product_spec_values"."option_id" is null;--> statement-breakpoint
CREATE INDEX "product_spec_values_field_id_index" ON "product"."product_spec_values" USING btree ("field_id");--> statement-breakpoint
CREATE INDEX "product_spec_values_option_id_index" ON "product"."product_spec_values" USING btree ("option_id");--> statement-breakpoint
CREATE UNIQUE INDEX "spec_field_options_field_lower_value_uq" ON "product"."spec_field_options" USING btree ("field_id",lower("value"));--> statement-breakpoint
CREATE UNIQUE INDEX "spec_fields_company_lower_name_uq" ON "product"."spec_fields" USING btree ("company_id",lower("name"));--> statement-breakpoint
ALTER TABLE "product"."product_groups" ADD CONSTRAINT "product_groups_axis1_attribute_id_attributes_id_fk" FOREIGN KEY ("axis1_attribute_id") REFERENCES "product"."attributes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product"."product_groups" ADD CONSTRAINT "product_groups_axis2_attribute_id_attributes_id_fk" FOREIGN KEY ("axis2_attribute_id") REFERENCES "product"."attributes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product"."attributes" ADD CONSTRAINT "attributes_platform_kind" CHECK ("product"."attributes"."platform_kind" in ('color', 'size', 'volume', 'flavor'));--> statement-breakpoint
ALTER TABLE "product"."product_groups" ADD CONSTRAINT "product_groups_axis_order" CHECK ("product"."product_groups"."axis2_attribute_id" is null or "product"."product_groups"."axis1_attribute_id" is not null);--> statement-breakpoint
ALTER TABLE "product"."product_groups" ADD CONSTRAINT "product_groups_axis_distinct" CHECK ("product"."product_groups"."axis1_attribute_id" <> "product"."product_groups"."axis2_attribute_id");