CREATE TYPE "finance"."invoice_status" AS ENUM('posted', 'reversed');--> statement-breakpoint
CREATE TYPE "finance"."receipt_source" AS ENUM('gateway', 'cod', 'settlement', 'unmatched_assignment');--> statement-breakpoint
CREATE TYPE "finance"."unmatched_reason" AS ENUM('no_payment_code', 'amount_mismatch', 'order_cancelled');--> statement-breakpoint
CREATE TYPE "finance"."unmatched_status" AS ENUM('open', 'assigned', 'refunded');--> statement-breakpoint
CREATE TYPE "finance"."voucher_purpose" AS ENUM('supplier_payment', 'customer_refund', 'unmatched_refund');--> statement-breakpoint
CREATE TYPE "finance"."voucher_status" AS ENUM('draft', 'posted', 'reversed');--> statement-breakpoint
CREATE TYPE "payment"."gateway" AS ENUM('vnpay', 'momo', 'zalopay', 'vietqr');--> statement-breakpoint
CREATE TYPE "payment"."link_status" AS ENUM('active', 'paid', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "payment"."payment_status" AS ENUM('unpaid', 'paid', 'cod_pending', 'cod_collected', 'not_collected');--> statement-breakpoint
CREATE TYPE "payment"."refund_status" AS ENUM('none', 'pending_refund', 'refunded');--> statement-breakpoint
CREATE TYPE "payment"."txn_source" AS ENUM('webhook', 'query', 'sepay');--> statement-breakpoint
CREATE TYPE "payment"."txn_status" AS ENUM('pending', 'succeeded', 'failed', 'needs_review');--> statement-breakpoint
CREATE TYPE "report"."order_source" AS ENUM('marketplace', 'inbox', 'manual');--> statement-breakpoint
CREATE TABLE "finance"."doc_counters" (
	"company_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"period" text DEFAULT '' NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "doc_counters_company_id_doc_type_period_pk" PRIMARY KEY("company_id","doc_type","period")
);
--> statement-breakpoint
CREATE TABLE "finance"."payment_vouchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"purpose" "finance"."voucher_purpose" NOT NULL,
	"supplier_invoice_id" uuid,
	"order_id" uuid,
	"unmatched_receipt_id" uuid,
	"amount" numeric(18, 2) NOT NULL,
	"paid_on" date NOT NULL,
	"note" text,
	"status" "finance"."voucher_status" DEFAULT 'draft' NOT NULL,
	"created_by" uuid NOT NULL,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"reversal_of_id" uuid,
	"reversal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "payment_vouchers_reversal_of_id_unique" UNIQUE("reversal_of_id"),
	CONSTRAINT "payment_vouchers_company_id_number_unique" UNIQUE("company_id","number"),
	CONSTRAINT "payment_vouchers_one_source" CHECK (num_nonnulls("finance"."payment_vouchers"."supplier_invoice_id", "finance"."payment_vouchers"."order_id", "finance"."payment_vouchers"."unmatched_receipt_id") <= 1),
	CONSTRAINT "payment_vouchers_amount_sign" CHECK ("finance"."payment_vouchers"."amount" <> 0 and ("finance"."payment_vouchers"."reversal_of_id" is null) = ("finance"."payment_vouchers"."amount" > 0)),
	CONSTRAINT "payment_vouchers_reversal_reason" CHECK (("finance"."payment_vouchers"."reversal_of_id" is null) = ("finance"."payment_vouchers"."reversal_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "finance"."receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"order_id" uuid,
	"source" "finance"."receipt_source" NOT NULL,
	"payment_transaction_id" uuid,
	"unmatched_receipt_id" uuid,
	"settlement_line_id" uuid,
	"amount" numeric(18, 2) NOT NULL,
	"status" "finance"."voucher_status" DEFAULT 'posted' NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversal_of_id" uuid,
	"reversal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "receipts_payment_transaction_id_unique" UNIQUE("payment_transaction_id"),
	CONSTRAINT "receipts_settlement_line_id_unique" UNIQUE("settlement_line_id"),
	CONSTRAINT "receipts_reversal_of_id_unique" UNIQUE("reversal_of_id"),
	CONSTRAINT "receipts_company_id_number_unique" UNIQUE("company_id","number"),
	CONSTRAINT "receipts_amount_sign" CHECK ("finance"."receipts"."amount" <> 0 and ("finance"."receipts"."reversal_of_id" is null) = ("finance"."receipts"."amount" > 0)),
	CONSTRAINT "receipts_reversal_reason" CHECK (("finance"."receipts"."reversal_of_id" is null) = ("finance"."receipts"."reversal_reason" is null)),
	CONSTRAINT "receipts_not_draft" CHECK ("finance"."receipts"."status" <> 'draft')
);
--> statement-breakpoint
CREATE TABLE "finance"."sales_invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price" numeric(18, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance"."sales_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"order_id" uuid NOT NULL,
	"status" "finance"."invoice_status" DEFAULT 'posted' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"total" numeric(18, 2) NOT NULL,
	"reversal_of_id" uuid,
	"reversal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "sales_invoices_reversal_of_id_unique" UNIQUE("reversal_of_id"),
	CONSTRAINT "sales_invoices_company_id_number_unique" UNIQUE("company_id","number"),
	CONSTRAINT "sales_invoices_reversal_reason" CHECK (("finance"."sales_invoices"."reversal_of_id" is null) = ("finance"."sales_invoices"."reversal_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "finance"."unmatched_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"payment_transaction_id" uuid,
	"amount" numeric(18, 2) NOT NULL,
	"transfer_content" text,
	"reason" "finance"."unmatched_reason" NOT NULL,
	"status" "finance"."unmatched_status" DEFAULT 'open' NOT NULL,
	"assigned_order_id" uuid,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment"."gateway_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"gateway" "payment"."gateway" NOT NULL,
	"credentials_enc" "bytea",
	"is_configured" boolean DEFAULT false NOT NULL,
	"webhook_receiver_key" text,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "gateway_configs_webhook_receiver_key_unique" UNIQUE("webhook_receiver_key"),
	CONSTRAINT "gateway_configs_company_id_gateway_unique" UNIQUE("company_id","gateway")
);
--> statement-breakpoint
CREATE TABLE "payment"."order_payments" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"status" "payment"."payment_status" NOT NULL,
	"refund_status" "payment"."refund_status" DEFAULT 'none' NOT NULL,
	"paid_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment"."payment_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"gateway" "payment"."gateway" NOT NULL,
	"payment_code" text NOT NULL,
	"gateway_order_ref" text,
	"amount" numeric(18, 2) NOT NULL,
	"pay_url" text,
	"qr_content" text,
	"expires_at" timestamp with time zone NOT NULL,
	"status" "payment"."link_status" DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "payment_links_payment_code_unique" UNIQUE("payment_code"),
	CONSTRAINT "payment_links_amount" CHECK ("payment"."payment_links"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "payment"."payment_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"payment_link_id" uuid,
	"order_id" uuid,
	"gateway" "payment"."gateway" NOT NULL,
	"gateway_txn_id" text NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"fee" numeric(18, 2),
	"source" "payment"."txn_source" NOT NULL,
	"status" "payment"."txn_status" DEFAULT 'pending' NOT NULL,
	"raw_payload" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "payment_transactions_gateway_gateway_txn_id_unique" UNIQUE("gateway","gateway_txn_id")
);
--> statement-breakpoint
CREATE TABLE "payment"."webhook_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payment"."webhook_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" uuid NOT NULL,
	"gateway" "payment"."gateway" NOT NULL,
	"event_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_company_id_gateway_event_key_unique" UNIQUE("company_id","gateway","event_key")
);
--> statement-breakpoint
CREATE TABLE "report"."daily_channel_summary" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "report"."daily_channel_summary_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" uuid NOT NULL,
	"day" date NOT NULL,
	"source" "report"."order_source" NOT NULL,
	"shop_id" uuid,
	"revenue" numeric(18, 2) DEFAULT '0' NOT NULL,
	"cash_collected" numeric(18, 2) DEFAULT '0' NOT NULL,
	"platform_fee" numeric(18, 2) DEFAULT '0' NOT NULL,
	"payment_fee" numeric(18, 2) DEFAULT '0' NOT NULL,
	"shipping_fee" numeric(18, 2) DEFAULT '0' NOT NULL,
	"cogs" numeric(18, 2) DEFAULT '0' NOT NULL,
	"profit" numeric(18, 2) DEFAULT '0' NOT NULL,
	"fees_pending" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "daily_channel_summary_company_id_day_source_shop_id_unique" UNIQUE NULLS NOT DISTINCT("company_id","day","source","shop_id")
);
--> statement-breakpoint
ALTER TABLE "finance"."payment_vouchers" ADD CONSTRAINT "payment_vouchers_unmatched_receipt_id_unmatched_receipts_id_fk" FOREIGN KEY ("unmatched_receipt_id") REFERENCES "finance"."unmatched_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."payment_vouchers" ADD CONSTRAINT "payment_vouchers_reversal_of_id_payment_vouchers_id_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "finance"."payment_vouchers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."receipts" ADD CONSTRAINT "receipts_unmatched_receipt_id_unmatched_receipts_id_fk" FOREIGN KEY ("unmatched_receipt_id") REFERENCES "finance"."unmatched_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."receipts" ADD CONSTRAINT "receipts_reversal_of_id_receipts_id_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "finance"."receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_invoice_id_sales_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "finance"."sales_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."sales_invoices" ADD CONSTRAINT "sales_invoices_reversal_of_id_sales_invoices_id_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "finance"."sales_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment"."payment_transactions" ADD CONSTRAINT "payment_transactions_payment_link_id_payment_links_id_fk" FOREIGN KEY ("payment_link_id") REFERENCES "payment"."payment_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_vouchers_order_id_index" ON "finance"."payment_vouchers" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payment_vouchers_unmatched_receipt_id_index" ON "finance"."payment_vouchers" USING btree ("unmatched_receipt_id");--> statement-breakpoint
CREATE INDEX "receipts_order_id_index" ON "finance"."receipts" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "receipts_unmatched_receipt_id_index" ON "finance"."receipts" USING btree ("unmatched_receipt_id");--> statement-breakpoint
CREATE INDEX "sales_invoice_lines_invoice_id_index" ON "finance"."sales_invoice_lines" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "sales_invoices_order_id_index" ON "finance"."sales_invoices" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_invoices_one_posted_per_order" ON "finance"."sales_invoices" USING btree ("order_id") WHERE "finance"."sales_invoices"."reversal_of_id" is null and "finance"."sales_invoices"."status" = 'posted';--> statement-breakpoint
CREATE INDEX "unmatched_receipts_payment_transaction_id_index" ON "finance"."unmatched_receipts" USING btree ("payment_transaction_id");--> statement-breakpoint
CREATE INDEX "unmatched_receipts_assigned_order_id_index" ON "finance"."unmatched_receipts" USING btree ("assigned_order_id");--> statement-breakpoint
CREATE INDEX "payment_links_order_id_index" ON "payment"."payment_links" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_links_one_active_per_order" ON "payment"."payment_links" USING btree ("order_id") WHERE "payment"."payment_links"."status" = 'active';--> statement-breakpoint
CREATE INDEX "payment_transactions_payment_link_id_index" ON "payment"."payment_transactions" USING btree ("payment_link_id");--> statement-breakpoint
CREATE INDEX "payment_transactions_order_id_index" ON "payment"."payment_transactions" USING btree ("order_id");