CREATE TABLE "channel"."listing_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"requested_by" uuid,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"total" integer,
	"processed" integer DEFAULT 0 NOT NULL,
	"succeeded" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" jsonb,
	CONSTRAINT "listing_sync_runs_status" CHECK ("channel"."listing_sync_runs"."status" in ('queued', 'running', 'done', 'failed')),
	CONSTRAINT "listing_sync_runs_counts" CHECK ("channel"."listing_sync_runs"."processed" >= 0 and "channel"."listing_sync_runs"."succeeded" >= 0 and "channel"."listing_sync_runs"."failed" >= 0 and "channel"."listing_sync_runs"."succeeded" + "channel"."listing_sync_runs"."failed" = "channel"."listing_sync_runs"."processed"),
	CONSTRAINT "listing_sync_runs_total" CHECK ("channel"."listing_sync_runs"."total" is null or "channel"."listing_sync_runs"."processed" <= "channel"."listing_sync_runs"."total"),
	CONSTRAINT "listing_sync_runs_started" CHECK (("channel"."listing_sync_runs"."status" = 'queued') = ("channel"."listing_sync_runs"."started_at" is null)),
	CONSTRAINT "listing_sync_runs_finished" CHECK (("channel"."listing_sync_runs"."status" in ('done', 'failed')) = ("channel"."listing_sync_runs"."finished_at" is not null)),
	CONSTRAINT "listing_sync_runs_error" CHECK ("channel"."listing_sync_runs"."error" is null or "channel"."listing_sync_runs"."status" = 'failed')
);
--> statement-breakpoint
ALTER TABLE "channel"."listing_sync_runs" ADD CONSTRAINT "listing_sync_runs_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "channel"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "listing_sync_runs_one_queued_uq" ON "channel"."listing_sync_runs" USING btree ("shop_id") WHERE "channel"."listing_sync_runs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "listing_sync_runs_shop_idx" ON "channel"."listing_sync_runs" USING btree ("shop_id","requested_at");