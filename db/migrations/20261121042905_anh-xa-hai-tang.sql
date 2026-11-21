ALTER TABLE "channel"."spec_option_mappings" DROP CONSTRAINT "spec_option_mappings_uq";--> statement-breakpoint
ALTER TABLE "channel"."spec_option_mappings" DROP CONSTRAINT "spec_option_mappings_field_fk";
--> statement-breakpoint
ALTER TABLE "channel"."axis_mappings" ALTER COLUMN "company_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "channel"."spec_field_mappings" ALTER COLUMN "company_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "channel"."spec_option_mappings" ALTER COLUMN "company_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "axis_mappings_platform_code_uq" ON "channel"."axis_mappings" USING btree ("attribute_id","platform","attribute_code") WHERE "channel"."axis_mappings"."company_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "axis_mappings_platform_priority_uq" ON "channel"."axis_mappings" USING btree ("attribute_id","platform","priority") WHERE "channel"."axis_mappings"."company_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "spec_field_mappings_platform_priority_uq" ON "channel"."spec_field_mappings" USING btree ("field_id","platform","priority") WHERE "channel"."spec_field_mappings"."company_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "spec_field_mappings_platform_attribute_uq" ON "channel"."spec_field_mappings" USING btree ("platform","attribute_code") WHERE "channel"."spec_field_mappings"."company_id" IS NULL;--> statement-breakpoint
ALTER TABLE "channel"."spec_field_mappings" ADD CONSTRAINT "spec_field_mappings_field_code_uq" UNIQUE("field_id","platform","attribute_code");--> statement-breakpoint
ALTER TABLE "channel"."spec_option_mappings" ADD CONSTRAINT "spec_option_mappings_option_uq" UNIQUE("option_id","platform","attribute_code");