ALTER TABLE "core"."audit_logs" ADD COLUMN "entity_label" text;--> statement-breakpoint
ALTER TABLE "core"."audit_logs" ADD COLUMN "operation" text;