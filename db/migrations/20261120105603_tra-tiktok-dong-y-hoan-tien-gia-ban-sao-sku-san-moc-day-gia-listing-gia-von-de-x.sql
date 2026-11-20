ALTER TABLE "channel"."price_calculations" DROP CONSTRAINT "price_calculations_trigger";--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD COLUMN "last_price_pushed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel"."remote_skus" ADD COLUMN "price" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "order"."return_requests" ADD COLUMN "respond_by" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order"."return_requests" ADD COLUMN "refund_approval" text;--> statement-breakpoint
CREATE INDEX "return_requests_refund_approval_pending_idx" ON "order"."return_requests" USING btree ("shop_id") WHERE "order"."return_requests"."refund_approval" = 'pending';--> statement-breakpoint
ALTER TABLE "channel"."price_calculations" ADD CONSTRAINT "price_calculations_trigger" CHECK ("channel"."price_calculations"."trigger" in ('push', 'target_changed', 'config_activated', 'cost'));--> statement-breakpoint
ALTER TABLE "channel"."remote_skus" ADD CONSTRAINT "remote_skus_price" CHECK ("channel"."remote_skus"."price" >= 0);--> statement-breakpoint
ALTER TABLE "order"."return_requests" ADD CONSTRAINT "return_requests_refund_approval" CHECK ("order"."return_requests"."refund_approval" is null or ("order"."return_requests"."refund_approval" in ('pending', 'done', 'withheld') and "order"."return_requests"."status" = 'closed' and "order"."return_requests"."source" = 'marketplace'));