ALTER TABLE "order"."orders" RENAME COLUMN "cancelling" TO "cancel_pending";--> statement-breakpoint
ALTER TABLE "order"."orders" ADD COLUMN "cancel_initiator" "order"."line_cancel_initiator";--> statement-breakpoint
ALTER TABLE "order"."orders" ADD CONSTRAINT "orders_cancel_pending_open" CHECK (not "order"."orders"."cancel_pending" or "order"."orders"."status" in ('unpaid', 'processing'));--> statement-breakpoint
ALTER TABLE "order"."orders" ADD CONSTRAINT "orders_cancel_requested_open" CHECK (not "order"."orders"."cancel_requested" or "order"."orders"."status" in ('unpaid', 'processing'));