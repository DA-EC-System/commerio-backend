CREATE TYPE "order"."return_kind" AS ENUM('return', 'refund');--> statement-breakpoint
CREATE TABLE "order"."unmatched_return_parcel_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"parcel_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unmatched_return_parcel_lines_parcel_id_variant_id_unique" UNIQUE("parcel_id","variant_id"),
	CONSTRAINT "unmatched_return_parcel_lines_quantity" CHECK ("order"."unmatched_return_parcel_lines"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "channel"."shops" ADD COLUMN "last_return_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order"."unmatched_return_parcels" ADD COLUMN "inspection_id" uuid;--> statement-breakpoint
ALTER TABLE "order"."unmatched_return_parcels" ADD COLUMN "inspection_number" text;--> statement-breakpoint
ALTER TABLE "order"."unmatched_return_parcels" ADD COLUMN "resolved_by" uuid;--> statement-breakpoint
ALTER TABLE "order"."unmatched_return_parcels" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order"."return_request_lines" ADD COLUMN "external_line_id" text;--> statement-breakpoint
ALTER TABLE "order"."return_request_lines" ADD COLUMN "package_returned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "order"."return_requests" ADD COLUMN "kind" "order"."return_kind" DEFAULT 'return' NOT NULL;--> statement-breakpoint
ALTER TABLE "order"."return_requests" ADD COLUMN "inspection_number" text;--> statement-breakpoint
ALTER TABLE "order"."return_requests" ADD COLUMN "attention_note" text;--> statement-breakpoint
ALTER TABLE "order"."return_requests" ADD COLUMN "raw_marketplace_status" text;--> statement-breakpoint
ALTER TABLE "order"."return_requests" ADD COLUMN "ofc_status" text;--> statement-breakpoint
ALTER TABLE "order"."return_requests" ADD COLUMN "dispute_in_progress" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "order"."return_requests" ADD COLUMN "return_to" text;--> statement-breakpoint
ALTER TABLE "order"."return_requests" ADD COLUMN "external_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order"."return_requests" ADD COLUMN "reject_reason_id" text;--> statement-breakpoint
ALTER TABLE "order"."return_requests" ADD COLUMN "reject_reason_label" text;--> statement-breakpoint
ALTER TABLE "order"."return_requests" ADD COLUMN "received_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order"."return_requests" ADD COLUMN "received_by" uuid;--> statement-breakpoint
ALTER TABLE "order"."return_requests" ADD COLUMN "refunded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order"."unmatched_return_parcel_lines" ADD CONSTRAINT "unmatched_return_parcel_lines_parcel_id_unmatched_return_parcels_id_fk" FOREIGN KEY ("parcel_id") REFERENCES "order"."unmatched_return_parcels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "unmatched_return_parcel_lines_parcel_id_index" ON "order"."unmatched_return_parcel_lines" USING btree ("parcel_id");--> statement-breakpoint
ALTER TABLE "order"."return_request_lines" ADD CONSTRAINT "return_request_lines_request_id_order_line_id_unique" UNIQUE("request_id","order_line_id");--> statement-breakpoint
ALTER TABLE "order"."unmatched_return_parcels" ADD CONSTRAINT "unmatched_return_parcels_resolved" CHECK (("order"."unmatched_return_parcels"."status" = 'open') = ("order"."unmatched_return_parcels"."resolved_at" is null));--> statement-breakpoint
ALTER TABLE "order"."return_requests" ADD CONSTRAINT "return_requests_return_to" CHECK ("order"."return_requests"."return_to" is null or "order"."return_requests"."return_to" in ('warehouse', 'merchant'));--> statement-breakpoint
ALTER TABLE "order"."return_requests" ADD CONSTRAINT "return_requests_received" CHECK ("order"."return_requests"."status" not in ('received') or "order"."return_requests"."received_at" is not null);--> statement-breakpoint
ALTER TABLE "order"."return_requests" ADD CONSTRAINT "return_requests_refunded" CHECK ("order"."return_requests"."refunded" = ("order"."return_requests"."refunded_at" is not null));