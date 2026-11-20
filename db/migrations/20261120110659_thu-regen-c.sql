ALTER TABLE "core"."audit_logs" ADD COLUMN "entity_name" text;--> statement-breakpoint
ALTER TABLE "core"."audit_logs" DROP COLUMN "entity_label";