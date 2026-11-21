CREATE TABLE "product"."purchase_product_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"parent_key" text NOT NULL,
	"description" text,
	"brand" text,
	"origin_country" text,
	"image_file_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"size_chart_file_id" uuid,
	"specs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"image_axis" text,
	"option_images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"variant_defaults" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"variant_facts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"product_id" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "purchase_product_drafts_request_parent_uq" UNIQUE("request_id","parent_key"),
	CONSTRAINT "purchase_product_drafts_images" CHECK (cardinality("product"."purchase_product_drafts"."image_file_ids") <= 9),
	CONSTRAINT "purchase_product_drafts_brand" CHECK ("product"."purchase_product_drafts"."brand" is null or char_length("product"."purchase_product_drafts"."brand") <= 100),
	CONSTRAINT "purchase_product_drafts_origin" CHECK ("product"."purchase_product_drafts"."origin_country" is null or "product"."purchase_product_drafts"."origin_country" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
ALTER TABLE "product"."purchase_product_drafts" ADD CONSTRAINT "purchase_product_drafts_request_id_purchase_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "product"."purchase_requests"("id") ON DELETE cascade ON UPDATE no action;