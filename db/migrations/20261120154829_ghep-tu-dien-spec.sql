ALTER TABLE "channel"."product_specs" ADD COLUMN "field_sources" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "channel"."product_specs" ADD COLUMN "remote_facts" jsonb;--> statement-breakpoint
ALTER TABLE "channel"."product_specs" ADD COLUMN "remote_read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel"."product_specs" ADD COLUMN "remote_shop_id" uuid;--> statement-breakpoint
ALTER TABLE "channel"."product_specs" ADD CONSTRAINT "product_specs_remote_shop_id_shops_id_fk" FOREIGN KEY ("remote_shop_id") REFERENCES "channel"."shops"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."product_specs" ADD CONSTRAINT "product_specs_remote" CHECK (("channel"."product_specs"."remote_facts" is null) = ("channel"."product_specs"."remote_read_at" is null));