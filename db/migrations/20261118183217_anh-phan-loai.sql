CREATE TABLE "product"."product_attribute_value_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"attribute_id" uuid NOT NULL,
	"attribute_value_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "pavi_product_value_uq" UNIQUE("product_id","attribute_value_id")
);
--> statement-breakpoint
ALTER TABLE "product"."products" ADD COLUMN "image_attribute_id" uuid;--> statement-breakpoint
ALTER TABLE "product"."products" ADD COLUMN "origin_country" text;--> statement-breakpoint
ALTER TABLE "product"."products" ADD COLUMN "brand" text;--> statement-breakpoint
CREATE INDEX "product_attribute_value_images_file_id_index" ON "product"."product_attribute_value_images" USING btree ("file_id");--> statement-breakpoint
ALTER TABLE "product"."products" ADD CONSTRAINT "products_image_attribute_id_attributes_id_fk" FOREIGN KEY ("image_attribute_id") REFERENCES "product"."attributes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product"."attribute_values" ADD CONSTRAINT "attribute_values_id_attribute_uq" UNIQUE("id","attribute_id");--> statement-breakpoint
ALTER TABLE "product"."products" ADD CONSTRAINT "products_id_image_attribute_uq" UNIQUE("id","image_attribute_id");--> statement-breakpoint
ALTER TABLE "product"."products" ADD CONSTRAINT "products_origin_country" CHECK ("product"."products"."origin_country" is null or "product"."products"."origin_country" ~ '^[A-Z]{2}$');--> statement-breakpoint
ALTER TABLE "product"."products" ADD CONSTRAINT "products_brand_length" CHECK ("product"."products"."brand" is null or char_length("product"."products"."brand") <= 100);