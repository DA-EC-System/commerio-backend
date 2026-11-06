CREATE TYPE "order"."line_cancel_initiator" AS ENUM('buyer', 'seller', 'platform');--> statement-breakpoint
CREATE TYPE "order"."line_cancel_kind" AS ENUM('cancellation', 'return', 'refund', 'failed_delivery');--> statement-breakpoint
ALTER TABLE "order"."packages" ADD COLUMN "shipment_provider" text;--> statement-breakpoint
ALTER TABLE "order"."packages" ADD COLUMN "shipping_provider_type" text;--> statement-breakpoint
ALTER TABLE "order"."packages" ADD COLUMN "shipping_type" text;--> statement-breakpoint
ALTER TABLE "order"."packages" ADD COLUMN "promised_shipping_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order"."order_lines" ADD COLUMN "thumbnail_url" text;--> statement-breakpoint
ALTER TABLE "order"."order_lines" ADD COLUMN "attributes_label" text;--> statement-breakpoint
ALTER TABLE "order"."order_lines" ADD COLUMN "external_sku_id" text;--> statement-breakpoint
ALTER TABLE "order"."order_lines" ADD COLUMN "external_shop_sku" text;--> statement-breakpoint
ALTER TABLE "order"."order_lines" ADD COLUMN "external_product_id" text;--> statement-breakpoint
ALTER TABLE "order"."order_lines" ADD COLUMN "paid_price" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "order"."order_lines" ADD COLUMN "tax_amount" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "order"."order_lines" ADD COLUMN "shipping_amount" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "order"."order_lines" ADD COLUMN "wallet_credits" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "order"."order_lines" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "order"."order_lines" ADD COLUMN "cancel_reason_detail" text;--> statement-breakpoint
ALTER TABLE "order"."order_lines" ADD COLUMN "cancel_initiator" "order"."line_cancel_initiator";--> statement-breakpoint
ALTER TABLE "order"."order_lines" ADD COLUMN "cancel_kind" "order"."line_cancel_kind";--> statement-breakpoint
ALTER TABLE "order"."order_lines" ADD COLUMN "reverse_order_id" text;--> statement-breakpoint
ALTER TABLE "order"."order_lines" ADD COLUMN "return_status" text;--> statement-breakpoint
ALTER TABLE "order"."orders" ADD COLUMN "platform_payment_method" text;--> statement-breakpoint
ALTER TABLE "order"."orders" ADD COLUMN "buyer_note" text;--> statement-breakpoint
ALTER TABLE "order"."orders" ADD COLUMN "shipping_fee_original" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "order"."orders" ADD COLUMN "shipping_fee_discount_seller" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "order"."orders" ADD COLUMN "shipping_fee_discount_platform" numeric(18, 2);