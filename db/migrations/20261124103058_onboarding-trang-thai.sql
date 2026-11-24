ALTER TABLE "channel"."shops" ADD COLUMN "setup_draft" jsonb;--> statement-breakpoint
ALTER TABLE "channel"."shops" ADD COLUMN "setup_draft_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."companies" ADD COLUMN "onboarding_completed_at" timestamp with time zone;