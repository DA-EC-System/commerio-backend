CREATE TYPE "staff"."invitation_status" AS ENUM('open', 'claimed', 'pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "staff"."invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"role_ids" uuid[] NOT NULL,
	"created_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" "staff"."invitation_status" DEFAULT 'open' NOT NULL,
	"email" text,
	"full_name" text,
	"account_id" uuid,
	"password_hash" text,
	"otp_hash" text,
	"otp_expires_at" timestamp with time zone,
	"otp_attempts" integer DEFAULT 0 NOT NULL,
	"otp_send_count" integer DEFAULT 0 NOT NULL,
	"otp_requested_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "invitations_role_ids_nonempty" CHECK (cardinality("staff"."invitations"."role_ids") >= 1),
	CONSTRAINT "invitations_identity_present" CHECK ("staff"."invitations"."status" = 'open' or ("staff"."invitations"."email" is not null and "staff"."invitations"."full_name" is not null)),
	CONSTRAINT "invitations_pending_shape" CHECK ("staff"."invitations"."status" <> 'pending' or ("staff"."invitations"."submitted_at" is not null and (("staff"."invitations"."password_hash" is not null)::int + ("staff"."invitations"."account_id" is not null)::int) = 1)),
	CONSTRAINT "invitations_approved_shape" CHECK ("staff"."invitations"."status" <> 'approved' or ("staff"."invitations"."account_id" is not null and "staff"."invitations"."decided_by" is not null and "staff"."invitations"."decided_at" is not null)),
	CONSTRAINT "invitations_rejected_shape" CHECK ("staff"."invitations"."status" <> 'rejected' or ("staff"."invitations"."decided_by" is not null and "staff"."invitations"."decided_at" is not null)),
	CONSTRAINT "invitations_otp_counters_range" CHECK ("staff"."invitations"."otp_attempts" between 0 and 5 and "staff"."invitations"."otp_send_count" between 0 and 5),
	CONSTRAINT "invitations_decided_clean" CHECK ("staff"."invitations"."status" not in ('approved', 'rejected') or ("staff"."invitations"."password_hash" is null and "staff"."invitations"."otp_hash" is null))
);
--> statement-breakpoint
ALTER TABLE "staff"."invitations" ADD CONSTRAINT "invitations_created_by_accounts_id_fk" FOREIGN KEY ("created_by") REFERENCES "staff"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff"."invitations" ADD CONSTRAINT "invitations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "staff"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff"."invitations" ADD CONSTRAINT "invitations_decided_by_accounts_id_fk" FOREIGN KEY ("decided_by") REFERENCES "staff"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invitations_queue_idx" ON "staff"."invitations" USING btree ("company_id","status","submitted_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "invitations_created_idx" ON "staff"."invitations" USING btree ("company_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "invitations_created_by_index" ON "staff"."invitations" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "invitations_account_id_index" ON "staff"."invitations" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "invitations_decided_by_index" ON "staff"."invitations" USING btree ("decided_by");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_one_pending_per_email" ON "staff"."invitations" USING btree ("company_id","email") WHERE "staff"."invitations"."status" = 'pending';