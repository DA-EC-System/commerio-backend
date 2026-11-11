CREATE TYPE "order"."return_kind" AS ENUM('return', 'refund');--> statement-breakpoint
ALTER TABLE "order"."return_requests" ADD COLUMN "kind" "order"."return_kind" DEFAULT 'return' NOT NULL;