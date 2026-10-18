CREATE TYPE "channel"."marketplace" AS ENUM('tiktok', 'shopee', 'lazada', 'mock');--> statement-breakpoint
CREATE TYPE "channel"."shop_status" AS ENUM('connected', 'expiring', 'deauthorized', 'disconnected');--> statement-breakpoint
CREATE TYPE "fulfillment"."batch_status" AS ENUM('open', 'picking', 'packed', 'done');--> statement-breakpoint
CREATE TYPE "fulfillment"."change_source" AS ENUM('user', 'marketplace', 'system');--> statement-breakpoint
CREATE TYPE "fulfillment"."fulfillment_status" AS ENUM('pending_confirmation', 'confirmed', 'picking', 'packing', 'issued', 'in_transit', 'delivered', 'delivery_failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "sales"."channel_kind" AS ENUM('tiktok', 'shopee', 'lazada', 'mock', 'messenger', 'email', 'zalo_oa');--> statement-breakpoint
CREATE TYPE "sales"."fulfillment_status" AS ENUM('pending_confirmation', 'confirmed', 'picking', 'packing', 'issued', 'in_transit', 'delivered', 'delivery_failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "sales"."order_source" AS ENUM('marketplace', 'inbox', 'manual');--> statement-breakpoint
CREATE TYPE "sales"."payment_method" AS ENUM('prepaid', 'cod');--> statement-breakpoint
CREATE TABLE "channel"."channel_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"external_product_id" text NOT NULL,
	"external_sku_id" text NOT NULL,
	"listing_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "channel_listings_company_id_external_sku_id_unique" UNIQUE("company_id","external_sku_id")
);
--> statement-breakpoint
CREATE TABLE "channel"."raw_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"order_id" uuid,
	"external_order_id" text NOT NULL,
	"external_status" text,
	"payload" jsonb NOT NULL,
	"external_update_time" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "raw_orders_company_id_external_order_id_unique" UNIQUE("company_id","external_order_id")
);
--> statement-breakpoint
CREATE TABLE "channel"."shops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"platform" "channel"."marketplace" NOT NULL,
	"external_shop_id" text NOT NULL,
	"shop_name" text NOT NULL,
	"region" text,
	"access_token_enc" "bytea",
	"refresh_token_enc" "bytea",
	"access_expires_at" timestamp with time zone,
	"status" "channel"."shop_status" DEFAULT 'connected' NOT NULL,
	"last_order_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "shops_company_id_external_shop_id_unique" UNIQUE("company_id","external_shop_id")
);
--> statement-breakpoint
CREATE TABLE "channel"."webhook_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "channel"."webhook_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" uuid NOT NULL,
	"platform" "channel"."marketplace" NOT NULL,
	"notification_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_company_id_notification_id_unique" UNIQUE("company_id","notification_id")
);
--> statement-breakpoint
CREATE TABLE "fulfillment"."order_status_history" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "fulfillment"."order_status_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"from_status" "fulfillment"."fulfillment_status",
	"to_status" "fulfillment"."fulfillment_status" NOT NULL,
	"actor_id" uuid,
	"source" "fulfillment"."change_source" NOT NULL,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fulfillment"."pick_batch_orders" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fulfillment"."pick_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"status" "fulfillment"."batch_status" DEFAULT 'open' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "pick_batches_company_id_code_unique" UNIQUE("company_id","code")
);
--> statement-breakpoint
CREATE TABLE "sales"."customer_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"channel_kind" "sales"."channel_kind" NOT NULL,
	"external_user_id" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "customer_identities_company_id_channel_kind_external_user_id_unique" UNIQUE("company_id","channel_kind","external_user_id")
);
--> statement-breakpoint
CREATE TABLE "sales"."customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text,
	"phone" text,
	"email" text,
	"address" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales"."doc_counters" (
	"company_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"period" text DEFAULT '' NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "doc_counters_company_id_doc_type_period_pk" PRIMARY KEY("company_id","doc_type","period")
);
--> statement-breakpoint
CREATE TABLE "sales"."order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"product_name" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price" numeric(18, 2) NOT NULL,
	"line_total" numeric(18, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "order_lines_quantity" CHECK ("sales"."order_lines"."quantity" > 0),
	CONSTRAINT "order_lines_unit_price" CHECK ("sales"."order_lines"."unit_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sales"."orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"customer_id" uuid,
	"source" "sales"."order_source" NOT NULL,
	"shop_id" uuid,
	"external_order_id" text,
	"conversation_id" uuid,
	"payment_method" "sales"."payment_method",
	"status" "sales"."fulfillment_status" DEFAULT 'pending_confirmation' NOT NULL,
	"is_short_stock" boolean DEFAULT false NOT NULL,
	"shipping_address" jsonb,
	"subtotal" numeric(18, 2) NOT NULL,
	"shipping_fee" numeric(18, 2) DEFAULT '0' NOT NULL,
	"total" numeric(18, 2) NOT NULL,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "orders_company_id_code_unique" UNIQUE("company_id","code"),
	CONSTRAINT "orders_company_id_shop_id_external_order_id_unique" UNIQUE("company_id","shop_id","external_order_id"),
	CONSTRAINT "orders_payment_method" CHECK (("sales"."orders"."source" = 'marketplace') = ("sales"."orders"."payment_method" is null)),
	CONSTRAINT "orders_marketplace_ref" CHECK ("sales"."orders"."source" <> 'marketplace' or ("sales"."orders"."shop_id" is not null and "sales"."orders"."external_order_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "channel"."channel_listings" ADD CONSTRAINT "channel_listings_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "channel"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."raw_orders" ADD CONSTRAINT "raw_orders_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "channel"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment"."pick_batch_orders" ADD CONSTRAINT "pick_batch_orders_batch_id_pick_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "fulfillment"."pick_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales"."customer_identities" ADD CONSTRAINT "customer_identities_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "sales"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales"."order_lines" ADD CONSTRAINT "order_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "sales"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales"."orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "sales"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_listings_shop_id_index" ON "channel"."channel_listings" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "channel_listings_variant_id_index" ON "channel"."channel_listings" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "raw_orders_shop_id_index" ON "channel"."raw_orders" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "raw_orders_order_id_index" ON "channel"."raw_orders" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_status_history_order_id_id_index" ON "fulfillment"."order_status_history" USING btree ("order_id","id");--> statement-breakpoint
CREATE INDEX "pick_batch_orders_batch_id_index" ON "fulfillment"."pick_batch_orders" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "customer_identities_customer_id_index" ON "sales"."customer_identities" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "order_lines_order_id_index" ON "sales"."order_lines" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_lines_variant_id_index" ON "sales"."order_lines" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "orders_customer_id_index" ON "sales"."orders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "orders_conversation_id_index" ON "sales"."orders" USING btree ("conversation_id");