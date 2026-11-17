CREATE TYPE "channel"."listing_revision_status" AS ENUM('auditing', 'failed');--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD COLUMN "revision_status" "channel"."listing_revision_status";--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD COLUMN "revision_reject_reason" text;--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD COLUMN "revision_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD CONSTRAINT "listings_revision" CHECK (("channel"."listings"."revision_status" is null) = ("channel"."listings"."revision_at" is null)
        and ("channel"."listings"."revision_reject_reason" is null or "channel"."listings"."revision_status" = 'failed')
        and ("channel"."listings"."revision_status" is null or "channel"."listings"."status" in ('live', 'hidden', 'platform_hold')));