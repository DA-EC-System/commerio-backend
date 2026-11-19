ALTER TABLE "order"."order_lines" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order"."orders" ADD COLUMN "cancel_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "order"."order_lines" ADD CONSTRAINT "order_lines_cancelled_at" CHECK ("order"."order_lines"."cancelled_at" is null or "order"."order_lines"."cancelled_qty" > 0);