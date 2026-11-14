ALTER TABLE "order"."packages" ADD COLUMN "lost_self_approved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "order"."packages" ADD COLUMN "lost_source" text;