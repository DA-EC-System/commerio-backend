ALTER TABLE "channel"."listings" ADD COLUMN "remote_title_at_match" text;--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD COLUMN "remote_title_en_at_match" text;--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD COLUMN "remote_title_matched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD COLUMN "remote_title_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel"."remote_skus" ADD COLUMN "title_en" text;--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD CONSTRAINT "listings_remote_title" CHECK (("channel"."listings"."remote_title_at_match" is not null or ("channel"."listings"."remote_title_en_at_match" is null and "channel"."listings"."remote_title_matched_at" is null))
        and ("channel"."listings"."remote_title_changed_at" is null or "channel"."listings"."remote_title_matched_at" is not null));