CREATE TYPE "assistant"."doc_processing" AS ENUM('processing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "finance"."discrepancy_reason" AS ENUM('order_not_found', 'revenue_mismatch', 'formula_mismatch');--> statement-breakpoint
CREATE TYPE "finance"."match_status" AS ENUM('matched', 'discrepancy', 'refund_tagged');--> statement-breakpoint
CREATE TYPE "finance"."settlement_line_kind" AS ENUM('order', 'adjustment', 'reserve');--> statement-breakpoint
CREATE TYPE "inbox"."message_kind" AS ENUM('messenger', 'email', 'zalo_oa', 'tiktok_chat', 'shopee_chat');--> statement-breakpoint
CREATE TYPE "inbox"."msg_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "inbox"."send_status" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "purchasing"."po_source" AS ENUM('manual', 'auto_reorder');--> statement-breakpoint
CREATE TYPE "purchasing"."po_status" AS ENUM('draft', 'pending_approval', 'approved', 'receiving', 'received', 'cancelled');--> statement-breakpoint
CREATE TABLE "assistant"."document_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"role_ids" uuid[],
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_chunks_document_id_chunk_index_unique" UNIQUE("document_id","chunk_index")
);
--> statement-breakpoint
CREATE TABLE "assistant"."document_roles" (
	"document_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "document_roles_document_id_role_id_pk" PRIMARY KEY("document_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "assistant"."documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" "assistant"."doc_processing" DEFAULT 'processing' NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance"."settlement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"kind" "finance"."settlement_line_kind" NOT NULL,
	"external_transaction_id" text NOT NULL,
	"order_id" uuid,
	"external_order_id" text,
	"revenue" numeric(18, 2) NOT NULL,
	"fees" jsonb NOT NULL,
	"shipping_cost" numeric(18, 2) DEFAULT '0' NOT NULL,
	"adjustment" numeric(18, 2) DEFAULT '0' NOT NULL,
	"settlement" numeric(18, 2) NOT NULL,
	"match_status" "finance"."match_status" NOT NULL,
	"discrepancy_reason" "finance"."discrepancy_reason",
	"raw" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "settlement_lines_company_id_external_transaction_id_unique" UNIQUE("company_id","external_transaction_id"),
	CONSTRAINT "settlement_lines_discrepancy_reason" CHECK (("finance"."settlement_lines"."match_status" = 'discrepancy') = ("finance"."settlement_lines"."discrepancy_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "finance"."settlement_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"external_statement_id" text NOT NULL,
	"statement_time" timestamp with time zone NOT NULL,
	"settlement_amount" numeric(18, 2) NOT NULL,
	"payment_status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "settlement_statements_company_id_external_statement_id_unique" UNIQUE("company_id","external_statement_id")
);
--> statement-breakpoint
CREATE TABLE "finance"."supplier_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"purchase_order_id" uuid,
	"invoice_no" text NOT NULL,
	"invoice_date" date NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"amount_due" numeric(18, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "supplier_invoices_amount" CHECK ("finance"."supplier_invoices"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "inbox"."conversation_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox"."conversation_tags" (
	"conversation_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "conversation_tags_conversation_id_tag_id_pk" PRIMARY KEY("conversation_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "inbox"."conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"message_channel_id" uuid NOT NULL,
	"customer_identity_id" uuid,
	"assignee_id" uuid,
	"external_conversation_id" text,
	"last_message_at" timestamp with time zone,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"reply_window_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox"."message_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" "inbox"."message_kind" NOT NULL,
	"external_account_id" text NOT NULL,
	"display_name" text NOT NULL,
	"shop_id" uuid,
	"access_token_enc" "bytea",
	"status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "message_channels_company_id_kind_external_account_id_unique" UNIQUE("company_id","kind","external_account_id")
);
--> statement-breakpoint
CREATE TABLE "inbox"."messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"external_message_id" text,
	"direction" "inbox"."msg_direction" NOT NULL,
	"type" text NOT NULL,
	"content" jsonb NOT NULL,
	"sender_id" uuid,
	"send_status" "inbox"."send_status",
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_company_id_external_message_id_unique" UNIQUE("company_id","external_message_id")
);
--> statement-breakpoint
CREATE TABLE "inbox"."tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "tags_company_id_name_unique" UNIQUE("company_id","name")
);
--> statement-breakpoint
CREATE TABLE "purchasing"."purchase_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"po_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"ordered_qty" integer NOT NULL,
	"received_qty" integer DEFAULT 0 NOT NULL,
	"unit_price" numeric(18, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "purchase_order_lines_ordered_qty" CHECK ("purchasing"."purchase_order_lines"."ordered_qty" > 0),
	CONSTRAINT "purchase_order_lines_received_qty" CHECK ("purchasing"."purchase_order_lines"."received_qty" >= 0),
	CONSTRAINT "purchase_order_lines_unit_price" CHECK ("purchasing"."purchase_order_lines"."unit_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "purchasing"."purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"supplier_id" uuid,
	"status" "purchasing"."po_status" DEFAULT 'draft' NOT NULL,
	"status_reason" text,
	"source" "purchasing"."po_source" DEFAULT 'manual' NOT NULL,
	"total" numeric(18, 2) DEFAULT '0' NOT NULL,
	"created_by" uuid NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "purchase_orders_company_id_code_unique" UNIQUE("company_id","code"),
	CONSTRAINT "purchase_orders_supplier_required" CHECK ("purchasing"."purchase_orders"."status" in ('draft', 'cancelled') or "purchasing"."purchase_orders"."supplier_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "purchasing"."suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"address" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistant"."document_chunks" ADD CONSTRAINT "document_chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "assistant"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant"."document_roles" ADD CONSTRAINT "document_roles_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "assistant"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."settlement_lines" ADD CONSTRAINT "settlement_lines_statement_id_settlement_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "finance"."settlement_statements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."conversation_notes" ADD CONSTRAINT "conversation_notes_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "inbox"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."conversation_tags" ADD CONSTRAINT "conversation_tags_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "inbox"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."conversation_tags" ADD CONSTRAINT "conversation_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "inbox"."tags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."conversations" ADD CONSTRAINT "conversations_message_channel_id_message_channels_id_fk" FOREIGN KEY ("message_channel_id") REFERENCES "inbox"."message_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "inbox"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchasing"."purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "purchasing"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchasing"."purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "purchasing"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_roles_role_id_index" ON "assistant"."document_roles" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "settlement_lines_statement_id_index" ON "finance"."settlement_lines" USING btree ("statement_id");--> statement-breakpoint
CREATE INDEX "settlement_lines_order_id_index" ON "finance"."settlement_lines" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "settlement_statements_shop_id_index" ON "finance"."settlement_statements" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "supplier_invoices_supplier_id_index" ON "finance"."supplier_invoices" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "supplier_invoices_purchase_order_id_index" ON "finance"."supplier_invoices" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "conversation_notes_conversation_id_index" ON "inbox"."conversation_notes" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "conversation_tags_tag_id_index" ON "inbox"."conversation_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "conversations_message_channel_id_index" ON "inbox"."conversations" USING btree ("message_channel_id");--> statement-breakpoint
CREATE INDEX "conversations_assignee_id_index" ON "inbox"."conversations" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_id_index" ON "inbox"."messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "purchase_order_lines_po_id_index" ON "purchasing"."purchase_order_lines" USING btree ("po_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_supplier_id_index" ON "purchasing"."purchase_orders" USING btree ("supplier_id");--> statement-breakpoint
ALTER TABLE "finance"."payment_vouchers" ADD CONSTRAINT "payment_vouchers_supplier_invoice_id_supplier_invoices_id_fk" FOREIGN KEY ("supplier_invoice_id") REFERENCES "finance"."supplier_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."receipts" ADD CONSTRAINT "receipts_settlement_line_id_settlement_lines_id_fk" FOREIGN KEY ("settlement_line_id") REFERENCES "finance"."settlement_lines"("id") ON DELETE no action ON UPDATE no action;