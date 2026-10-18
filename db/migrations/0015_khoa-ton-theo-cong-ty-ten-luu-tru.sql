ALTER TABLE "inventory"."reorder_rules" DROP CONSTRAINT "reorder_rules_variant_id_unique";--> statement-breakpoint
DROP INDEX "catalog"."products_company_lower_name_uq";--> statement-breakpoint
ALTER TABLE "inventory"."stock_levels" DROP CONSTRAINT "stock_levels_pkey";--> statement-breakpoint
ALTER TABLE "inventory"."stock_levels" ADD CONSTRAINT "stock_levels_company_id_variant_id_pk" PRIMARY KEY("company_id","variant_id");--> statement-breakpoint
ALTER TABLE "inventory"."stock_issues" ADD COLUMN "reference" text;--> statement-breakpoint
ALTER TABLE "inventory"."stock_receipts" ADD COLUMN "reference" text;--> statement-breakpoint
CREATE UNIQUE INDEX "products_company_lower_name_uq" ON "catalog"."products" USING btree ("company_id",lower("name")) WHERE "catalog"."products"."archived_at" is null;--> statement-breakpoint
ALTER TABLE "inventory"."reorder_rules" ADD CONSTRAINT "reorder_rules_company_id_variant_id_unique" UNIQUE("company_id","variant_id");