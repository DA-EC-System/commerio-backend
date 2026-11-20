CREATE TABLE "core"."registrations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"full_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"company_name" text NOT NULL,
	"tax_code" text NOT NULL,
	"otp_hash" text,
	"otp_requested_at" timestamp with time zone NOT NULL,
	"otp_expires_at" timestamp with time zone NOT NULL,
	"otp_attempts" integer DEFAULT 0 NOT NULL,
	"otp_send_count" integer DEFAULT 1 NOT NULL,
	"account_notice_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registrations_otp_counters_range" CHECK ("core"."registrations"."otp_attempts" between 0 and 5 and "core"."registrations"."otp_send_count" between 1 and 5)
);
--> statement-breakpoint
CREATE INDEX "registrations_email_created_at_index" ON "core"."registrations" USING btree ("email","created_at");--> statement-breakpoint
CREATE INDEX "registrations_created_at_index" ON "core"."registrations" USING btree ("created_at");