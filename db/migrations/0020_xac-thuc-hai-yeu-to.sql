ALTER TABLE "staff"."invitations" DROP CONSTRAINT "invitations_decided_clean";--> statement-breakpoint
ALTER TABLE "staff"."accounts" ADD COLUMN "totp_secret_enc" "bytea";--> statement-breakpoint
ALTER TABLE "staff"."accounts" ADD COLUMN "totp_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff"."accounts" ADD COLUMN "totp_last_step" bigint;--> statement-breakpoint
ALTER TABLE "staff"."accounts" ADD COLUMN "recovery_code_hashes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "staff"."invitations" ADD COLUMN "totp_secret_enc" "bytea";--> statement-breakpoint
ALTER TABLE "staff"."invitations" ADD COLUMN "totp_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff"."invitations" ADD COLUMN "recovery_code_hashes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "staff"."accounts" ADD CONSTRAINT "accounts_totp_enabled_has_secret" CHECK ("staff"."accounts"."totp_enabled_at" is null or "staff"."accounts"."totp_secret_enc" is not null);--> statement-breakpoint
ALTER TABLE "staff"."invitations" ADD CONSTRAINT "invitations_totp_confirmed_has_secret" CHECK ("staff"."invitations"."totp_confirmed_at" is null or "staff"."invitations"."totp_secret_enc" is not null);--> statement-breakpoint
ALTER TABLE "staff"."invitations" ADD CONSTRAINT "invitations_decided_clean" CHECK ("staff"."invitations"."status" not in ('approved', 'rejected') or ("staff"."invitations"."password_hash" is null and "staff"."invitations"."otp_hash" is null and "staff"."invitations"."totp_secret_enc" is null and cardinality("staff"."invitations"."recovery_code_hashes") = 0));