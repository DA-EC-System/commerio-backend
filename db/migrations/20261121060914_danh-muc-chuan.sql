CREATE TABLE "product"."group_allowed_attributes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"group_id" uuid NOT NULL,
	"attribute_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_allowed_attributes_group_attr_company_uq" UNIQUE NULLS NOT DISTINCT("group_id","attribute_id","company_id"),
	CONSTRAINT "group_allowed_attributes_position" CHECK ("product"."group_allowed_attributes"."position" >= 0)
);
--> statement-breakpoint
ALTER TABLE "product"."attributes" DROP CONSTRAINT "attributes_platform_kind";--> statement-breakpoint
ALTER TABLE "product"."product_groups" ADD COLUMN "renamed_from" text;--> statement-breakpoint
ALTER TABLE "product"."product_groups" ADD COLUMN "split_into" uuid[];--> statement-breakpoint
ALTER TABLE "product"."group_allowed_attributes" ADD CONSTRAINT "group_allowed_attributes_group_id_product_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "product"."product_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product"."group_allowed_attributes" ADD CONSTRAINT "group_allowed_attributes_attribute_id_attributes_id_fk" FOREIGN KEY ("attribute_id") REFERENCES "product"."attributes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_allowed_attributes_attribute_id_index" ON "product"."group_allowed_attributes" USING btree ("attribute_id");--> statement-breakpoint
ALTER TABLE "product"."attributes" ADD CONSTRAINT "attributes_platform_kind" CHECK ("product"."attributes"."platform_kind" in ('color', 'size', 'shoe_size', 'bra_size', 'age', 'ring_size', 'storage', 'version', 'screen_size', 'connector', 'length', 'battery_capacity', 'voltage', 'power', 'volume', 'weight', 'flavor', 'scent', 'pack', 'diaper_size', 'bed_size', 'style', 'compatible_model'));--> statement-breakpoint
ALTER TABLE "product"."product_groups" ADD CONSTRAINT "product_groups_merge_platform" CHECK ("product"."product_groups"."company_id" is null or ("product"."product_groups"."renamed_from" is null and "product"."product_groups"."split_into" is null));