CREATE TABLE "channel"."platform_category_group_maps" (
	"platform" text NOT NULL,
	"external_category_id" text NOT NULL,
	"group_id" uuid NOT NULL,
	CONSTRAINT "platform_category_group_maps_platform_external_category_id_pk" PRIMARY KEY("platform","external_category_id")
);
--> statement-breakpoint
ALTER TABLE "channel"."marketplaces" ADD COLUMN "category_sync_state" text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE "channel"."marketplaces" ADD COLUMN "category_sync_error" text;--> statement-breakpoint
ALTER TABLE "channel"."marketplaces" ADD COLUMN "category_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel"."shops" ADD COLUMN "category_permissions_state" text;--> statement-breakpoint
ALTER TABLE "channel"."shops" ADD COLUMN "category_permissions_error" text;--> statement-breakpoint
ALTER TABLE "channel"."shops" ADD COLUMN "category_permissions_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel"."marketplaces" ADD CONSTRAINT "marketplaces_category_sync_state" CHECK ("channel"."marketplaces"."category_sync_state" in ('idle', 'queued', 'running', 'failed', 'unsupported'));--> statement-breakpoint
ALTER TABLE "channel"."shops" ADD CONSTRAINT "shops_category_permissions_state" CHECK ("channel"."shops"."category_permissions_state" in ('queued', 'running', 'ready', 'failed'));