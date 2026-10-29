DROP INDEX "product"."purchase_request_lines_request_id_index";--> statement-breakpoint
ALTER TABLE "product"."suppliers" ADD COLUMN "note" text;--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_company_lower_name_uq" ON "product"."suppliers" USING btree ("company_id",lower("name"));--> statement-breakpoint
ALTER TABLE "product"."purchase_request_lines" ADD CONSTRAINT "purchase_request_lines_request_variant_uq" UNIQUE("request_id","variant_id");