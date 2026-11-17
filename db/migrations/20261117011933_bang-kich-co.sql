ALTER TABLE "channel"."category_maps" ADD COLUMN "size_chart_rule" text;--> statement-breakpoint
ALTER TABLE "product"."products" ADD COLUMN "size_chart_file_id" uuid;--> statement-breakpoint
ALTER TABLE "channel"."category_maps" ADD CONSTRAINT "category_maps_size_chart_rule" CHECK ("channel"."category_maps"."size_chart_rule" in ('required', 'optional', 'unsupported'));