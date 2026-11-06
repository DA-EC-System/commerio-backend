ALTER TABLE "core"."refresh_tokens" ADD COLUMN "family_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."refresh_tokens" ADD COLUMN "rotated_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_id_index" ON "core"."refresh_tokens" USING btree ("family_id");