ALTER TABLE "product"."categories" ADD COLUMN "margin_coefficient" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "product"."categories" ADD COLUMN "price_rounding" integer;--> statement-breakpoint
ALTER TABLE "product"."categories" ADD COLUMN "reorder_lead_days" integer;--> statement-breakpoint
ALTER TABLE "product"."categories" ADD COLUMN "reorder_safety_qty" integer;--> statement-breakpoint
ALTER TABLE "product"."categories" ADD COLUMN "reorder_default_qty" integer;--> statement-breakpoint
ALTER TABLE "product"."categories" ADD CONSTRAINT "categories_margin_coefficient" CHECK ("product"."categories"."margin_coefficient" >= 1);--> statement-breakpoint
ALTER TABLE "product"."categories" ADD CONSTRAINT "categories_price_rounding" CHECK ("product"."categories"."price_rounding" > 0);--> statement-breakpoint
ALTER TABLE "product"."categories" ADD CONSTRAINT "categories_reorder_config" CHECK ("product"."categories"."reorder_lead_days" >= 0 and "product"."categories"."reorder_safety_qty" >= 0 and "product"."categories"."reorder_default_qty" >= 0);