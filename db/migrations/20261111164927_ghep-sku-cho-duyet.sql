ALTER TABLE "channel"."listings" DROP CONSTRAINT "listings_unmanaged_approved";--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD COLUMN "pending_variant_id" uuid;--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD COLUMN "pending_mode" "channel"."listing_mode";--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD COLUMN "pending_requested_by" uuid;--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD COLUMN "pending_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD COLUMN "mapping_self_approved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD CONSTRAINT "listings_pending_mapping" CHECK (("channel"."listings"."pending_mode" is null and "channel"."listings"."pending_variant_id" is null and "channel"."listings"."pending_requested_by" is null and "channel"."listings"."pending_requested_at" is null)
        or ("channel"."listings"."pending_requested_by" is not null and "channel"."listings"."pending_requested_at" is not null and "channel"."listings"."pending_mode" is not null and ("channel"."listings"."pending_mode" = 'mapped') = ("channel"."listings"."pending_variant_id" is not null)));--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD CONSTRAINT "listings_unmanaged_approved" CHECK ("channel"."listings"."mode" = 'mapped' or "channel"."listings"."approved_by" is not null or "channel"."listings"."pending_requested_by" is not null);