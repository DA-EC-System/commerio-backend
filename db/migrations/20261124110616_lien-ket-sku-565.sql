ALTER TABLE "channel"."remote_skus" ADD COLUMN "variant_label" text;--> statement-breakpoint
ALTER TABLE "channel"."remote_skus" ADD COLUMN "image_url" text;--> statement-breakpoint
ALTER TABLE "channel"."remote_skus" ADD COLUMN "external_category_id" text;--> statement-breakpoint
ALTER TABLE "channel"."shops" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "channel"."shops" ADD CONSTRAINT "shops_display_name" CHECK (char_length("channel"."shops"."display_name") between 1 and 60);