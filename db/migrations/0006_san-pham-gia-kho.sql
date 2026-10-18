CREATE TYPE "inventory"."doc_status" AS ENUM('draft', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "inventory"."issue_kind" AS ENUM('manual', 'order');--> statement-breakpoint
CREATE TYPE "inventory"."receipt_kind" AS ENUM('purchase', 'manual', 'delivery_return');--> statement-breakpoint
CREATE TYPE "inventory"."reservation_status" AS ENUM('active', 'consumed', 'released');--> statement-breakpoint
CREATE TYPE "pricing"."pricelist_type" AS ENUM('standard', 'channel');--> statement-breakpoint
CREATE TABLE "catalog"."attribute_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"attribute_id" uuid NOT NULL,
	"value" text NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "attribute_values_attribute_id_code_unique" UNIQUE("attribute_id","code"),
	CONSTRAINT "attribute_values_code_format" CHECK ("catalog"."attribute_values"."code" ~ '^[A-Z0-9]{1,6}$')
);
--> statement-breakpoint
CREATE TABLE "catalog"."attributes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog"."categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sku_pattern" text NOT NULL,
	"sku_next_seq" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog"."product_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog"."product_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "product_variants_company_id_sku_unique" UNIQUE("company_id","sku")
);
--> statement-breakpoint
CREATE TABLE "catalog"."products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog"."variant_attribute_values" (
	"variant_id" uuid NOT NULL,
	"attribute_value_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "variant_attribute_values_variant_id_attribute_value_id_pk" PRIMARY KEY("variant_id","attribute_value_id")
);
--> statement-breakpoint
CREATE TABLE "inventory"."doc_counters" (
	"company_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"period" text DEFAULT '' NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "doc_counters_company_id_doc_type_period_pk" PRIMARY KEY("company_id","doc_type","period")
);
--> statement-breakpoint
CREATE TABLE "inventory"."reorder_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"min_qty" integer NOT NULL,
	"alert_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "reorder_rules_variant_id_unique" UNIQUE("variant_id"),
	CONSTRAINT "reorder_rules_min_qty" CHECK ("inventory"."reorder_rules"."min_qty" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory"."reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"status" "inventory"."reservation_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "reservations_order_id_variant_id_unique" UNIQUE("order_id","variant_id"),
	CONSTRAINT "reservations_quantity" CHECK ("inventory"."reservations"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "inventory"."stock_issue_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_cost" numeric(18, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "stock_issue_lines_quantity" CHECK ("inventory"."stock_issue_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "inventory"."stock_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"kind" "inventory"."issue_kind" NOT NULL,
	"order_id" uuid,
	"status" "inventory"."doc_status" DEFAULT 'draft' NOT NULL,
	"note" text,
	"created_by" uuid,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "stock_issues_company_id_number_unique" UNIQUE("company_id","number"),
	CONSTRAINT "stock_issues_order" CHECK (("inventory"."stock_issues"."kind" = 'order') = ("inventory"."stock_issues"."order_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "inventory"."stock_levels" (
	"variant_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"on_hand" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"avg_cost" numeric(18, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "stock_levels_on_hand" CHECK ("inventory"."stock_levels"."on_hand" >= 0),
	CONSTRAINT "stock_levels_reserved" CHECK ("inventory"."stock_levels"."reserved" >= 0),
	CONSTRAINT "stock_levels_reserved_le_on_hand" CHECK ("inventory"."stock_levels"."reserved" <= "inventory"."stock_levels"."on_hand")
);
--> statement-breakpoint
CREATE TABLE "inventory"."stock_moves" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inventory"."stock_moves_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"qty_change" integer NOT NULL,
	"on_hand_after" integer NOT NULL,
	"receipt_line_id" uuid,
	"issue_line_id" uuid,
	"unit_cost" numeric(18, 2),
	"done_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_moves_qty_change" CHECK ("inventory"."stock_moves"."qty_change" <> 0),
	CONSTRAINT "stock_moves_on_hand_after" CHECK ("inventory"."stock_moves"."on_hand_after" >= 0),
	CONSTRAINT "stock_moves_one_source" CHECK (num_nonnulls("inventory"."stock_moves"."receipt_line_id", "inventory"."stock_moves"."issue_line_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "inventory"."stock_receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_cost" numeric(18, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "stock_receipt_lines_quantity" CHECK ("inventory"."stock_receipt_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "inventory"."stock_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"kind" "inventory"."receipt_kind" NOT NULL,
	"purchase_order_id" uuid,
	"order_id" uuid,
	"status" "inventory"."doc_status" DEFAULT 'draft' NOT NULL,
	"note" text,
	"created_by" uuid,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "stock_receipts_company_id_number_unique" UNIQUE("company_id","number"),
	CONSTRAINT "stock_receipts_purchase_order" CHECK (("inventory"."stock_receipts"."kind" = 'purchase') = ("inventory"."stock_receipts"."purchase_order_id" is not null)),
	CONSTRAINT "stock_receipts_return_order" CHECK (("inventory"."stock_receipts"."kind" = 'delivery_return') = ("inventory"."stock_receipts"."order_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "pricing"."pricelist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"pricelist_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"price" numeric(18, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "pricelist_items_pricelist_id_variant_id_unique" UNIQUE("pricelist_id","variant_id"),
	CONSTRAINT "pricelist_items_price_not_negative" CHECK ("pricing"."pricelist_items"."price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pricing"."pricelists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" "pricing"."pricelist_type" NOT NULL,
	"shop_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "pricelists_shop_id_unique" UNIQUE("shop_id"),
	CONSTRAINT "pricelists_shop_matches_type" CHECK (("pricing"."pricelists"."type" = 'channel') = ("pricing"."pricelists"."shop_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "catalog"."attribute_values" ADD CONSTRAINT "attribute_values_attribute_id_attributes_id_fk" FOREIGN KEY ("attribute_id") REFERENCES "catalog"."attributes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."product_images" ADD CONSTRAINT "product_images_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "catalog"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "catalog"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "catalog"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."variant_attribute_values" ADD CONSTRAINT "variant_attribute_values_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "catalog"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."variant_attribute_values" ADD CONSTRAINT "variant_attribute_values_attribute_value_id_attribute_values_id_fk" FOREIGN KEY ("attribute_value_id") REFERENCES "catalog"."attribute_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_issue_lines" ADD CONSTRAINT "stock_issue_lines_issue_id_stock_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "inventory"."stock_issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_moves" ADD CONSTRAINT "stock_moves_receipt_line_id_stock_receipt_lines_id_fk" FOREIGN KEY ("receipt_line_id") REFERENCES "inventory"."stock_receipt_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_moves" ADD CONSTRAINT "stock_moves_issue_line_id_stock_issue_lines_id_fk" FOREIGN KEY ("issue_line_id") REFERENCES "inventory"."stock_issue_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_receipt_lines" ADD CONSTRAINT "stock_receipt_lines_receipt_id_stock_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "inventory"."stock_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing"."pricelist_items" ADD CONSTRAINT "pricelist_items_pricelist_id_pricelists_id_fk" FOREIGN KEY ("pricelist_id") REFERENCES "pricing"."pricelists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_values_attribute_lower_value_uq" ON "catalog"."attribute_values" USING btree ("attribute_id",lower("value"));--> statement-breakpoint
CREATE UNIQUE INDEX "attributes_company_lower_name_uq" ON "catalog"."attributes" USING btree ("company_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "categories_company_lower_name_uq" ON "catalog"."categories" USING btree ("company_id",lower("name"));--> statement-breakpoint
CREATE INDEX "product_images_product_id_index" ON "catalog"."product_images" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "product_images_file_id_index" ON "catalog"."product_images" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "product_variants_product_id_index" ON "catalog"."product_variants" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_company_lower_name_uq" ON "catalog"."products" USING btree ("company_id",lower("name"));--> statement-breakpoint
CREATE INDEX "products_category_id_index" ON "catalog"."products" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "variant_attribute_values_attribute_value_id_index" ON "catalog"."variant_attribute_values" USING btree ("attribute_value_id");--> statement-breakpoint
CREATE INDEX "reservations_variant_id_index" ON "inventory"."reservations" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "stock_issue_lines_issue_id_index" ON "inventory"."stock_issue_lines" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "stock_issue_lines_variant_id_index" ON "inventory"."stock_issue_lines" USING btree ("variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_issues_one_per_order" ON "inventory"."stock_issues" USING btree ("order_id") WHERE "inventory"."stock_issues"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "stock_moves_variant_id_id_index" ON "inventory"."stock_moves" USING btree ("variant_id","id");--> statement-breakpoint
CREATE INDEX "stock_moves_receipt_line_id_index" ON "inventory"."stock_moves" USING btree ("receipt_line_id");--> statement-breakpoint
CREATE INDEX "stock_moves_issue_line_id_index" ON "inventory"."stock_moves" USING btree ("issue_line_id");--> statement-breakpoint
CREATE INDEX "stock_receipt_lines_receipt_id_index" ON "inventory"."stock_receipt_lines" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "stock_receipt_lines_variant_id_index" ON "inventory"."stock_receipt_lines" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "stock_receipts_purchase_order_id_index" ON "inventory"."stock_receipts" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "stock_receipts_order_id_index" ON "inventory"."stock_receipts" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_receipts_one_return_per_order" ON "inventory"."stock_receipts" USING btree ("order_id") WHERE "inventory"."stock_receipts"."kind" = 'delivery_return' and "inventory"."stock_receipts"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "pricelist_items_variant_id_index" ON "pricing"."pricelist_items" USING btree ("variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pricelists_one_standard_per_company" ON "pricing"."pricelists" USING btree ("company_id") WHERE "pricing"."pricelists"."type" = 'standard';