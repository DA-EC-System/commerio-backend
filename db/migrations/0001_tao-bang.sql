CREATE SCHEMA "channel";
--> statement-breakpoint
CREATE SCHEMA "core";
--> statement-breakpoint
CREATE SCHEMA "finance";
--> statement-breakpoint
CREATE SCHEMA "insight";
--> statement-breakpoint
CREATE SCHEMA "order";
--> statement-breakpoint
CREATE SCHEMA "product";
--> statement-breakpoint
CREATE TYPE "channel"."hidden_by" AS ENUM('platform', 'zero_stock');--> statement-breakpoint
CREATE TYPE "channel"."listing_mode" AS ENUM('mapped', 'unmanaged');--> statement-breakpoint
CREATE TYPE "channel"."listing_status" AS ENUM('pushing', 'push_failed', 'under_review', 'rejected', 'live', 'hidden', 'platform_hold', 'delisted');--> statement-breakpoint
CREATE TYPE "channel"."marketplace" AS ENUM('lazada', 'shopee', 'tiktok', 'mock');--> statement-breakpoint
CREATE TYPE "channel"."price_calc_status" AS ENUM('pending_confirm', 'confirmed', 'pushed', 'superseded');--> statement-breakpoint
CREATE TYPE "channel"."shop_status" AS ENUM('connecting', 'active', 'needs_reauth', 'disconnected');--> statement-breakpoint
CREATE TYPE "channel"."sync_state" AS ENUM('synced', 'pending', 'error');--> statement-breakpoint
CREATE TYPE "channel"."message_kind" AS ENUM('messenger', 'email', 'zalo_oa', 'tiktok_chat', 'shopee_chat');--> statement-breakpoint
CREATE TYPE "channel"."msg_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "channel"."send_status" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "core"."role_kind" AS ENUM('builtin', 'custom');--> statement-breakpoint
CREATE TYPE "core"."audit_action" AS ENUM('create', 'update', 'delete');--> statement-breakpoint
CREATE TYPE "core"."company_status" AS ENUM('active', 'locked');--> statement-breakpoint
CREATE TYPE "core"."module_code" AS ENUM('platform', 'identity', 'catalog', 'pricing', 'inventory', 'sales', 'fulfillment', 'finance', 'payment', 'notification', 'purchasing', 'channel', 'inbox', 'assistant', 'report');--> statement-breakpoint
CREATE TYPE "core"."transition_source" AS ENUM('user', 'marketplace', 'system');--> statement-breakpoint
CREATE TYPE "core"."invitation_status" AS ENUM('open', 'claimed', 'pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "core"."membership_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "finance"."settlement_batch_status" AS ENUM('running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "finance"."config_kind" AS ENUM('fee', 'tax_regime', 'tax_rules', 'mismatch_threshold', 'min_margin');--> statement-breakpoint
CREATE TYPE "finance"."config_status" AS ENUM('draft', 'pending_approval', 'rejected', 'scheduled', 'active', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "finance"."discrepancy_reason" AS ENUM('order_not_found', 'revenue_mismatch', 'formula_mismatch');--> statement-breakpoint
CREATE TYPE "finance"."invoice_status" AS ENUM('posted', 'reversed');--> statement-breakpoint
CREATE TYPE "finance"."ledger_kind" AS ENUM('revenue', 'platform_subsidy', 'shipping_income', 'shipping_cost', 'fee_fixed', 'fee_transaction', 'fee_service', 'fee_optional', 'withholding_tax', 'customer_refund', 'return_fee', 'lost_compensation', 'penalty', 'cogs', 'cogs_reversal', 'ads', 'opex', 'supplier_payment', 'supplier_refund', 'cod_collected', 'adjustment');--> statement-breakpoint
CREATE TYPE "finance"."match_status" AS ENUM('matched', 'discrepancy', 'refund_tagged');--> statement-breakpoint
CREATE TYPE "finance"."receipt_source" AS ENUM('gateway', 'cod', 'settlement', 'unmatched_assignment');--> statement-breakpoint
CREATE TYPE "finance"."settlement_line_kind" AS ENUM('order', 'adjustment', 'reserve');--> statement-breakpoint
CREATE TYPE "finance"."settlement_source" AS ENUM('api', 'file');--> statement-breakpoint
CREATE TYPE "finance"."settlement_state" AS ENUM('none', 'pending', 'settled', 'mismatch', 'resolved');--> statement-breakpoint
CREATE TYPE "finance"."unmatched_reason" AS ENUM('no_payment_code', 'amount_mismatch', 'order_cancelled');--> statement-breakpoint
CREATE TYPE "finance"."unmatched_status" AS ENUM('open', 'assigned', 'refunded');--> statement-breakpoint
CREATE TYPE "finance"."voucher_purpose" AS ENUM('supplier_payment', 'customer_refund', 'unmatched_refund');--> statement-breakpoint
CREATE TYPE "finance"."voucher_status" AS ENUM('draft', 'posted', 'reversed');--> statement-breakpoint
CREATE TYPE "finance"."gateway" AS ENUM('vnpay', 'momo', 'zalopay', 'vietqr');--> statement-breakpoint
CREATE TYPE "finance"."link_status" AS ENUM('active', 'paid', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "finance"."payment_status" AS ENUM('unpaid', 'paid', 'cod_pending', 'cod_collected', 'not_collected');--> statement-breakpoint
CREATE TYPE "finance"."refund_status" AS ENUM('none', 'pending_refund', 'refunded');--> statement-breakpoint
CREATE TYPE "finance"."txn_source" AS ENUM('webhook', 'query', 'sepay');--> statement-breakpoint
CREATE TYPE "finance"."txn_status" AS ENUM('pending', 'succeeded', 'failed', 'needs_review');--> statement-breakpoint
CREATE TYPE "insight"."doc_processing" AS ENUM('processing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "insight"."order_source" AS ENUM('marketplace', 'inbox', 'manual');--> statement-breakpoint
CREATE TYPE "order"."open_purpose" AS ENUM('cancel', 'edit', 'resplit');--> statement-breakpoint
CREATE TYPE "order"."package_status" AS ENUM('backordered', 'reserved', 'packed', 'awaiting_pickup', 'self_delivering', 'in_transit', 'delivered', 'delivery_failed', 'returning', 'returned', 'lost', 'cancelled');--> statement-breakpoint
CREATE TYPE "order"."unmatched_parcel_status" AS ENUM('open', 'attached', 'dismissed');--> statement-breakpoint
CREATE TYPE "order"."channel_kind" AS ENUM('tiktok', 'shopee', 'lazada', 'mock', 'messenger', 'email', 'zalo_oa');--> statement-breakpoint
CREATE TYPE "order"."order_outcome" AS ENUM('full', 'partial', 'none');--> statement-breakpoint
CREATE TYPE "order"."order_source" AS ENUM('marketplace', 'inbox', 'manual');--> statement-breakpoint
CREATE TYPE "order"."order_status" AS ENUM('unpaid', 'processing', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "order"."payment_method" AS ENUM('prepaid', 'cod');--> statement-breakpoint
CREATE TYPE "order"."return_close_result" AS ENUM('inspected', 'no_show', 'buyer_cancelled');--> statement-breakpoint
CREATE TYPE "order"."return_status" AS ENUM('requested', 'rejected', 'refund_only', 'awaiting_return', 'received', 'closed');--> statement-breakpoint
CREATE TYPE "product"."business_status" AS ENUM('selling', 'paused', 'discontinued', 'archived');--> statement-breakpoint
CREATE TYPE "product"."reject_decision" AS ENUM('restock', 'supplier_return');--> statement-breakpoint
CREATE TYPE "product"."stock_bucket" AS ENUM('on_hand', 'quarantine');--> statement-breakpoint
CREATE TYPE "product"."stock_document_kind" AS ENUM('stocktake', 'write_off', 'to_quarantine', 'return_inspection', 'shipment', 'shipment_reversal');--> statement-breakpoint
CREATE TYPE "product"."stock_document_status" AS ENUM('draft', 'pending', 'posted', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TYPE "product"."stock_source_type" AS ENUM('goods_receipt', 'stock_document', 'supplier_return');--> statement-breakpoint
CREATE TYPE "product"."cancel_decision" AS ENUM('restock', 'write_off');--> statement-breakpoint
CREATE TYPE "product"."delivery_mode" AS ENUM('driver_waiting', 'driver_left');--> statement-breakpoint
CREATE TYPE "product"."goods_receipt_status" AS ENUM('counting', 'matched', 'short', 'resolved', 'cancelled');--> statement-breakpoint
CREATE TYPE "product"."purchase_request_source" AS ENUM('manual', 'reorder', 'replacement');--> statement-breakpoint
CREATE TYPE "product"."purchase_request_status" AS ENUM('draft', 'pending_approval', 'changes_requested', 'rejected', 'approved', 'ordered', 'partially_received', 'received', 'closed_short', 'cancelled');--> statement-breakpoint
CREATE TYPE "product"."short_resolution" AS ENUM('follow_up', 'close_short', 'supplier_wrong');--> statement-breakpoint
CREATE TYPE "product"."supplier_return_source" AS ENUM('receipt_defect', 'quarantine', 'customer_return', 'write_off_rejected', 'manual');--> statement-breakpoint
CREATE TYPE "product"."supplier_return_status" AS ENUM('draft', 'pending_approval', 'sent', 'refunded', 'replaced', 'returned_to_us', 'cancelled');--> statement-breakpoint
CREATE TABLE "channel"."listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"mode" "channel"."listing_mode" DEFAULT 'mapped' NOT NULL,
	"variant_id" uuid,
	"external_product_id" text,
	"external_sku_id" text,
	"seller_sku" text,
	"status" "channel"."listing_status" DEFAULT 'pushing' NOT NULL,
	"reject_reason" text,
	"push_error" text,
	"push_attempts" integer DEFAULT 0 NOT NULL,
	"push_started_at" timestamp with time zone,
	"hidden_by" "channel"."hidden_by",
	"stock_sync" "channel"."sync_state" DEFAULT 'pending' NOT NULL,
	"price_sync" "channel"."sync_state" DEFAULT 'pending' NOT NULL,
	"platform_stock" integer,
	"listed_price" numeric(18, 2),
	"manual_price" numeric(18, 2),
	"price_calc_id" uuid,
	"delisted_by_disconnect" boolean DEFAULT false NOT NULL,
	"approved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "listings_mode" CHECK (("channel"."listings"."mode" = 'mapped') = ("channel"."listings"."variant_id" is not null)),
	CONSTRAINT "listings_unmanaged_approved" CHECK ("channel"."listings"."mode" = 'mapped' or "channel"."listings"."approved_by" is not null),
	CONSTRAINT "listings_hidden_by" CHECK ("channel"."listings"."hidden_by" is null or "channel"."listings"."status" in ('hidden', 'live')),
	CONSTRAINT "listings_reject_reason" CHECK ("channel"."listings"."status" <> 'rejected' or "channel"."listings"."reject_reason" is not null),
	CONSTRAINT "listings_push_attempts" CHECK ("channel"."listings"."push_attempts" >= 0),
	CONSTRAINT "listings_prices" CHECK ("channel"."listings"."listed_price" >= 0 and "channel"."listings"."manual_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "channel"."price_calculations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"fee_version_id" uuid,
	"tax_version_id" uuid,
	"cost" numeric(18, 2) NOT NULL,
	"target_net" numeric(18, 2) NOT NULL,
	"raw_price" numeric(18, 2) NOT NULL,
	"rounded_price" numeric(18, 2) NOT NULL,
	"net_received" numeric(18, 2) NOT NULL,
	"margin_pct" numeric(7, 2) NOT NULL,
	"below_floor" boolean NOT NULL,
	"status" "channel"."price_calc_status" DEFAULT 'pending_confirm' NOT NULL,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "price_calculations_floor" CHECK (not "channel"."price_calculations"."below_floor" or "channel"."price_calculations"."status" in ('pending_confirm', 'superseded')),
	CONSTRAINT "price_calculations_confirmed" CHECK ("channel"."price_calculations"."status" not in ('confirmed', 'pushed') or "channel"."price_calculations"."confirmed_by" is not null)
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
	CONSTRAINT "raw_orders_shop_id_external_order_id_unique" UNIQUE("shop_id","external_order_id")
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
	"status" "channel"."shop_status" DEFAULT 'connecting' NOT NULL,
	"order_cutoff_at" timestamp with time zone,
	"last_order_sync_at" timestamp with time zone,
	"settlement_cursor" timestamp with time zone,
	"last_error" text,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "shops_company_id_platform_external_shop_id_unique" UNIQUE("company_id","platform","external_shop_id"),
	CONSTRAINT "shops_active_cutoff" CHECK ("channel"."shops"."status" <> 'active' or "channel"."shops"."order_cutoff_at" is not null)
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
	CONSTRAINT "webhook_events_company_id_platform_notification_id_unique" UNIQUE("company_id","platform","notification_id")
);
--> statement-breakpoint
CREATE TABLE "channel"."conversation_notes" (
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
CREATE TABLE "channel"."conversation_tags" (
	"conversation_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "conversation_tags_conversation_id_tag_id_pk" PRIMARY KEY("conversation_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "channel"."conversations" (
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
CREATE TABLE "channel"."message_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" "channel"."message_kind" NOT NULL,
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
CREATE TABLE "channel"."messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"external_message_id" text,
	"direction" "channel"."msg_direction" NOT NULL,
	"type" text NOT NULL,
	"content" jsonb NOT NULL,
	"sender_id" uuid,
	"send_status" "channel"."send_status",
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_company_id_external_message_id_unique" UNIQUE("company_id","external_message_id")
);
--> statement-breakpoint
CREATE TABLE "channel"."tags" (
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
CREATE TABLE "core"."member_roles" (
	"membership_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	CONSTRAINT "member_roles_membership_id_role_id_pk" PRIMARY KEY("membership_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "core"."permissions" (
	"code" text PRIMARY KEY NOT NULL,
	"module_code" text NOT NULL,
	"description" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_code" text NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_code_pk" PRIMARY KEY("role_id","permission_code")
);
--> statement-breakpoint
CREATE TABLE "core"."roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"name" text NOT NULL,
	"kind" "core"."role_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "roles_company_id_name_unique" UNIQUE NULLS NOT DISTINCT("company_id","name"),
	CONSTRAINT "roles_kind_company_check" CHECK (("core"."roles"."kind" = 'builtin') = ("core"."roles"."company_id" is null))
);
--> statement-breakpoint
CREATE TABLE "core"."audit_logs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "core"."audit_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" uuid,
	"actor_id" uuid,
	"action" "core"."audit_action" NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"purpose" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "files_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "core"."refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"company_id" uuid,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "core"."companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"tax_code" text NOT NULL,
	"status" "core"."company_status" DEFAULT 'active' NOT NULL,
	"lock_reason" text,
	"locked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."company_modules" (
	"company_id" uuid NOT NULL,
	"module_code" "core"."module_code" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"enabled_by" uuid,
	"ai_consent_at" timestamp with time zone,
	"ai_consent_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "company_modules_company_id_module_code_pk" PRIMARY KEY("company_id","module_code")
);
--> statement-breakpoint
CREATE TABLE "core"."outbox_messages" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "core"."outbox_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"event_id" uuid NOT NULL,
	"company_id" uuid,
	"type" text NOT NULL,
	"topic" text NOT NULL,
	"key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "outbox_messages_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "core"."processed_events" (
	"consumer" text NOT NULL,
	"event_id" uuid NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_events_consumer_event_id_pk" PRIMARY KEY("consumer","event_id")
);
--> statement-breakpoint
CREATE TABLE "core"."state_transitions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "core"."state_transitions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"action" text NOT NULL,
	"actor_id" uuid,
	"source" "core"."transition_source" NOT NULL,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"full_name" text NOT NULL,
	"password_hash" text,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"google_sub" text,
	"is_platform_admin" boolean DEFAULT false NOT NULL,
	"password_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "accounts_email_unique" UNIQUE("email"),
	CONSTRAINT "accounts_google_sub_unique" UNIQUE("google_sub")
);
--> statement-breakpoint
CREATE TABLE "core"."invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"role_ids" uuid[] NOT NULL,
	"created_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" "core"."invitation_status" DEFAULT 'open' NOT NULL,
	"email" text,
	"full_name" text,
	"account_id" uuid,
	"password_hash" text,
	"otp_hash" text,
	"otp_expires_at" timestamp with time zone,
	"otp_attempts" integer DEFAULT 0 NOT NULL,
	"otp_send_count" integer DEFAULT 0 NOT NULL,
	"otp_requested_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "invitations_role_ids_nonempty" CHECK (cardinality("core"."invitations"."role_ids") >= 1),
	CONSTRAINT "invitations_identity_present" CHECK ("core"."invitations"."status" = 'open' or ("core"."invitations"."email" is not null and "core"."invitations"."full_name" is not null)),
	CONSTRAINT "invitations_pending_shape" CHECK ("core"."invitations"."status" <> 'pending' or ("core"."invitations"."submitted_at" is not null and (("core"."invitations"."password_hash" is not null)::int + ("core"."invitations"."account_id" is not null)::int) = 1)),
	CONSTRAINT "invitations_approved_shape" CHECK ("core"."invitations"."status" <> 'approved' or ("core"."invitations"."account_id" is not null and "core"."invitations"."decided_by" is not null and "core"."invitations"."decided_at" is not null)),
	CONSTRAINT "invitations_rejected_shape" CHECK ("core"."invitations"."status" <> 'rejected' or ("core"."invitations"."decided_by" is not null and "core"."invitations"."decided_at" is not null)),
	CONSTRAINT "invitations_otp_counters_range" CHECK ("core"."invitations"."otp_attempts" between 0 and 5 and "core"."invitations"."otp_send_count" between 0 and 5),
	CONSTRAINT "invitations_decided_clean" CHECK ("core"."invitations"."status" not in ('approved', 'rejected') or ("core"."invitations"."password_hash" is null and "core"."invitations"."otp_hash" is null))
);
--> statement-breakpoint
CREATE TABLE "core"."memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"status" "core"."membership_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "memberships_company_id_account_id_unique" UNIQUE("company_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "finance"."config_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" "finance"."config_kind" NOT NULL,
	"shop_id" uuid,
	"status" "finance"."config_status" DEFAULT 'draft' NOT NULL,
	"payload" jsonb NOT NULL,
	"effective_from" date,
	"effective_to" date,
	"supersedes_id" uuid,
	"is_correction" boolean DEFAULT false NOT NULL,
	"retroactive_from" date,
	"dry_run_result" jsonb,
	"status_reason" text,
	"created_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"self_approved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "config_versions_second_person" CHECK ("finance"."config_versions"."approved_by" is null or "finance"."config_versions"."approved_by" is distinct from "finance"."config_versions"."created_by" or "finance"."config_versions"."self_approved"),
	CONSTRAINT "config_versions_fee_shop" CHECK (("finance"."config_versions"."kind" = 'fee') = ("finance"."config_versions"."shop_id" is not null)),
	CONSTRAINT "config_versions_effective" CHECK ("finance"."config_versions"."status" not in ('scheduled', 'active', 'expired') or "finance"."config_versions"."effective_from" is not null),
	CONSTRAINT "config_versions_range" CHECK ("finance"."config_versions"."effective_to" is null or "finance"."config_versions"."effective_to" >= "finance"."config_versions"."effective_from"),
	CONSTRAINT "config_versions_retroactive" CHECK ("finance"."config_versions"."retroactive_from" is null or "finance"."config_versions"."is_correction"),
	CONSTRAINT "config_versions_approved" CHECK ("finance"."config_versions"."status" not in ('scheduled', 'active', 'expired') or "finance"."config_versions"."approved_by" is not null)
);
--> statement-breakpoint
CREATE TABLE "finance"."doc_counters" (
	"company_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"period" text DEFAULT '' NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "doc_counters_company_id_doc_type_period_pk" PRIMARY KEY("company_id","doc_type","period")
);
--> statement-breakpoint
CREATE TABLE "finance"."ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" "finance"."ledger_kind" NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"is_estimate" boolean NOT NULL,
	"occurred_on" date NOT NULL,
	"order_id" uuid,
	"package_id" uuid,
	"return_request_id" uuid,
	"shop_id" uuid,
	"source_type" text,
	"source_id" uuid,
	"replaces_entry_id" uuid,
	"config_version_id" uuid,
	"settlement_line_id" uuid,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_amount" CHECK ("finance"."ledger_entries"."amount" <> 0),
	CONSTRAINT "ledger_entries_actual_replaces" CHECK ("finance"."ledger_entries"."replaces_entry_id" is null or not "finance"."ledger_entries"."is_estimate"),
	CONSTRAINT "ledger_entries_adjustment_reason" CHECK ("finance"."ledger_entries"."kind" <> 'adjustment' or "finance"."ledger_entries"."reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "finance"."order_settlements" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"shop_id" uuid,
	"status" "finance"."settlement_state" DEFAULT 'none' NOT NULL,
	"estimated_total" numeric(18, 2) DEFAULT '0' NOT NULL,
	"settled_total" numeric(18, 2),
	"diff" numeric(18, 2),
	"resolved_diff_base" numeric(18, 2),
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolved_reason" text,
	"approved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "order_settlements_resolved" CHECK ("finance"."order_settlements"."status" <> 'resolved' or ("finance"."order_settlements"."resolved_by" is not null and "finance"."order_settlements"."resolved_reason" is not null)),
	CONSTRAINT "order_settlements_settled" CHECK ("finance"."order_settlements"."status" not in ('settled', 'resolved') or "finance"."order_settlements"."settled_total" is not null),
	CONSTRAINT "order_settlements_approver" CHECK ("finance"."order_settlements"."approved_by" is null or "finance"."order_settlements"."approved_by" is distinct from "finance"."order_settlements"."resolved_by")
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
CREATE TABLE "finance"."settlement_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"source" "finance"."settlement_source" NOT NULL,
	"file_id" uuid,
	"period_from" timestamp with time zone NOT NULL,
	"period_to" timestamp with time zone NOT NULL,
	"status" "finance"."settlement_batch_status" DEFAULT 'running' NOT NULL,
	"line_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "settlement_batches_file" CHECK (("finance"."settlement_batches"."source" = 'file') = ("finance"."settlement_batches"."file_id" is not null)),
	CONSTRAINT "settlement_batches_period" CHECK ("finance"."settlement_batches"."period_from" <= "finance"."settlement_batches"."period_to")
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
	"batch_id" uuid,
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
	"purchase_request_id" uuid,
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
CREATE TABLE "finance"."gateway_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"gateway" "finance"."gateway" NOT NULL,
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
CREATE TABLE "finance"."order_payments" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"status" "finance"."payment_status" NOT NULL,
	"refund_status" "finance"."refund_status" DEFAULT 'none' NOT NULL,
	"paid_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance"."payment_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"gateway" "finance"."gateway" NOT NULL,
	"payment_code" text NOT NULL,
	"gateway_order_ref" text,
	"amount" numeric(18, 2) NOT NULL,
	"pay_url" text,
	"qr_content" text,
	"expires_at" timestamp with time zone NOT NULL,
	"status" "finance"."link_status" DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "payment_links_payment_code_unique" UNIQUE("payment_code"),
	CONSTRAINT "payment_links_amount" CHECK ("finance"."payment_links"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "finance"."payment_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"payment_link_id" uuid,
	"order_id" uuid,
	"gateway" "finance"."gateway" NOT NULL,
	"gateway_txn_id" text NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"fee" numeric(18, 2),
	"source" "finance"."txn_source" NOT NULL,
	"status" "finance"."txn_status" DEFAULT 'pending' NOT NULL,
	"raw_payload" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "payment_transactions_gateway_gateway_txn_id_unique" UNIQUE("gateway","gateway_txn_id")
);
--> statement-breakpoint
CREATE TABLE "finance"."webhook_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "finance"."webhook_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" uuid NOT NULL,
	"gateway" "finance"."gateway" NOT NULL,
	"event_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_company_id_gateway_event_key_unique" UNIQUE("company_id","gateway","event_key")
);
--> statement-breakpoint
CREATE TABLE "insight"."document_chunks" (
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
CREATE TABLE "insight"."document_roles" (
	"document_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "document_roles_document_id_role_id_pk" PRIMARY KEY("document_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "insight"."documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" "insight"."doc_processing" DEFAULT 'processing' NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insight"."daily_channel_summary" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "insight"."daily_channel_summary_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" uuid NOT NULL,
	"day" date NOT NULL,
	"source" "insight"."order_source" NOT NULL,
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
CREATE TABLE "order"."package_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"variant_id" uuid,
	"quantity" integer NOT NULL,
	"reserved_qty" integer DEFAULT 0 NOT NULL,
	"packed_qty" integer DEFAULT 0 NOT NULL,
	"unit_cost" numeric(18, 2),
	"stock_deducted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "package_lines_quantity" CHECK ("order"."package_lines"."quantity" > 0),
	CONSTRAINT "package_lines_reserved_whole" CHECK ("order"."package_lines"."reserved_qty" in (0, "order"."package_lines"."quantity")),
	CONSTRAINT "package_lines_packed" CHECK ("order"."package_lines"."packed_qty" >= 0 and "order"."package_lines"."packed_qty" <= "order"."package_lines"."quantity"),
	CONSTRAINT "package_lines_unmapped" CHECK ("order"."package_lines"."variant_id" is not null or "order"."package_lines"."reserved_qty" = 0),
	CONSTRAINT "package_lines_deducted_cost" CHECK (not "order"."package_lines"."stock_deducted" or "order"."package_lines"."unit_cost" is not null)
);
--> statement-breakpoint
CREATE TABLE "order"."packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"order_id" uuid NOT NULL,
	"shop_id" uuid,
	"platform_package_code" text,
	"tracking_code" text,
	"self_delivery" boolean DEFAULT false NOT NULL,
	"status" "order"."package_status" NOT NULL,
	"needs_open" boolean DEFAULT false NOT NULL,
	"open_purpose" "order"."open_purpose",
	"needs_attention" boolean DEFAULT false NOT NULL,
	"flag_note" text,
	"ship_by" timestamp with time zone,
	"packed_by" uuid,
	"packed_at" timestamp with time zone,
	"handed_over_by" uuid,
	"handed_over_at" timestamp with time zone,
	"delivered_by" uuid,
	"delivered_at" timestamp with time zone,
	"cod_expected" numeric(18, 2),
	"cod_collected" numeric(18, 2),
	"cod_confirmed_by" uuid,
	"cod_confirmed_at" timestamp with time zone,
	"lost_reported_by" uuid,
	"lost_reported_at" timestamp with time zone,
	"lost_claim_code" text,
	"lost_confirmed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "packages_company_id_code_unique" UNIQUE("company_id","code"),
	CONSTRAINT "packages_open" CHECK ("order"."packages"."needs_open" = ("order"."packages"."open_purpose" is not null)),
	CONSTRAINT "packages_cod_second_person" CHECK ("order"."packages"."cod_confirmed_by" is null or "order"."packages"."cod_confirmed_by" is distinct from "order"."packages"."delivered_by"),
	CONSTRAINT "packages_lost_second_person" CHECK ("order"."packages"."lost_confirmed_by" is null or "order"."packages"."lost_confirmed_by" is distinct from "order"."packages"."lost_reported_by"),
	CONSTRAINT "packages_lost_report" CHECK (("order"."packages"."lost_reported_by" is null) = ("order"."packages"."lost_claim_code" is null)),
	CONSTRAINT "packages_handed_over" CHECK ("order"."packages"."status" in ('backordered', 'reserved', 'packed', 'awaiting_pickup', 'cancelled') or "order"."packages"."handed_over_at" is not null),
	CONSTRAINT "packages_cod" CHECK ("order"."packages"."cod_expected" >= 0 and "order"."packages"."cod_collected" >= 0)
);
--> statement-breakpoint
CREATE TABLE "order"."unmatched_return_parcels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"scanned_code" text NOT NULL,
	"status" "order"."unmatched_parcel_status" DEFAULT 'open' NOT NULL,
	"return_request_id" uuid,
	"note" text,
	"status_reason" text,
	"received_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "unmatched_return_parcels_company_id_code_unique" UNIQUE("company_id","code"),
	CONSTRAINT "unmatched_return_parcels_attached" CHECK (("order"."unmatched_return_parcels"."status" = 'attached') = ("order"."unmatched_return_parcels"."return_request_id" is not null)),
	CONSTRAINT "unmatched_return_parcels_dismissed" CHECK ("order"."unmatched_return_parcels"."status" <> 'dismissed' or "order"."unmatched_return_parcels"."status_reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "order"."customer_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"channel_kind" "order"."channel_kind" NOT NULL,
	"external_user_id" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "customer_identities_company_id_channel_kind_external_user_id_unique" UNIQUE("company_id","channel_kind","external_user_id")
);
--> statement-breakpoint
CREATE TABLE "order"."customers" (
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
CREATE TABLE "order"."doc_counters" (
	"company_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"period" text DEFAULT '' NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "doc_counters_company_id_doc_type_period_pk" PRIMARY KEY("company_id","doc_type","period")
);
--> statement-breakpoint
CREATE TABLE "order"."order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"variant_id" uuid,
	"external_line_id" text,
	"external_sku" text,
	"sku" text,
	"product_name" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price" numeric(18, 2) NOT NULL,
	"seller_discount" numeric(18, 2) DEFAULT '0' NOT NULL,
	"platform_discount" numeric(18, 2) DEFAULT '0' NOT NULL,
	"line_total" numeric(18, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "order_lines_order_id_external_line_id_unique" UNIQUE("order_id","external_line_id"),
	CONSTRAINT "order_lines_quantity" CHECK ("order"."order_lines"."quantity" > 0),
	CONSTRAINT "order_lines_unit_price" CHECK ("order"."order_lines"."unit_price" >= 0),
	CONSTRAINT "order_lines_item" CHECK ("order"."order_lines"."variant_id" is not null or "order"."order_lines"."external_sku" is not null)
);
--> statement-breakpoint
CREATE TABLE "order"."orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"customer_id" uuid,
	"source" "order"."order_source" NOT NULL,
	"shop_id" uuid,
	"external_order_id" text,
	"conversation_id" uuid,
	"payment_method" "order"."payment_method",
	"is_cod" boolean DEFAULT false NOT NULL,
	"status" "order"."order_status" DEFAULT 'unpaid' NOT NULL,
	"outcome" "order"."order_outcome",
	"raw_marketplace_status" text,
	"placed_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"ship_by" timestamp with time zone,
	"return_window_ends_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"needs_attention" boolean DEFAULT false NOT NULL,
	"attention_note" text,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"cancelling" boolean DEFAULT false NOT NULL,
	"platform_cancelled" boolean DEFAULT false NOT NULL,
	"shop_disconnected" boolean DEFAULT false NOT NULL,
	"shipping_address" jsonb,
	"subtotal" numeric(18, 2) NOT NULL,
	"seller_discount" numeric(18, 2) DEFAULT '0' NOT NULL,
	"platform_discount" numeric(18, 2) DEFAULT '0' NOT NULL,
	"shipping_fee" numeric(18, 2) DEFAULT '0' NOT NULL,
	"total" numeric(18, 2) NOT NULL,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "orders_company_id_code_unique" UNIQUE("company_id","code"),
	CONSTRAINT "orders_company_id_shop_id_external_order_id_unique" UNIQUE("company_id","shop_id","external_order_id"),
	CONSTRAINT "orders_outcome" CHECK (("order"."orders"."status" = 'completed') = ("order"."orders"."outcome" is not null)),
	CONSTRAINT "orders_cod" CHECK ("order"."orders"."source" = 'marketplace' or not "order"."orders"."is_cod"),
	CONSTRAINT "orders_amounts" CHECK ("order"."orders"."subtotal" >= 0 and "order"."orders"."total" >= 0 and "order"."orders"."shipping_fee" >= 0),
	CONSTRAINT "orders_payment_method" CHECK (("order"."orders"."source" = 'marketplace') = ("order"."orders"."payment_method" is null)),
	CONSTRAINT "orders_marketplace_ref" CHECK ("order"."orders"."source" <> 'marketplace' or ("order"."orders"."shop_id" is not null and "order"."orders"."external_order_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "order"."return_request_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"package_id" uuid,
	"variant_id" uuid,
	"quantity" integer NOT NULL,
	"unit_price" numeric(18, 2) NOT NULL,
	"unit_cost" numeric(18, 2),
	"resell_qty" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "return_request_lines_quantity" CHECK ("order"."return_request_lines"."quantity" > 0),
	CONSTRAINT "return_request_lines_resell" CHECK ("order"."return_request_lines"."resell_qty" >= 0 and "order"."return_request_lines"."resell_qty" <= "order"."return_request_lines"."quantity")
);
--> statement-breakpoint
CREATE TABLE "order"."return_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"order_id" uuid NOT NULL,
	"source" "order"."order_source" NOT NULL,
	"shop_id" uuid,
	"external_return_id" text,
	"status" "order"."return_status" DEFAULT 'requested' NOT NULL,
	"close_result" "order"."return_close_result",
	"reason" text NOT NULL,
	"status_reason" text,
	"return_tracking_code" text,
	"refund_amount" numeric(18, 2) DEFAULT '0' NOT NULL,
	"refunded" boolean DEFAULT false NOT NULL,
	"resell_cost" numeric(18, 2),
	"inspection_id" uuid,
	"needs_attention" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "return_requests_company_id_code_unique" UNIQUE("company_id","code"),
	CONSTRAINT "return_requests_shop_id_external_return_id_unique" UNIQUE("shop_id","external_return_id"),
	CONSTRAINT "return_requests_closed" CHECK (("order"."return_requests"."status" = 'closed') = ("order"."return_requests"."close_result" is not null)),
	CONSTRAINT "return_requests_marketplace_ref" CHECK ("order"."return_requests"."source" <> 'marketplace' or ("order"."return_requests"."shop_id" is not null and "order"."return_requests"."external_return_id" is not null)),
	CONSTRAINT "return_requests_refund" CHECK ("order"."return_requests"."refund_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "product"."attribute_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"attribute_id" uuid NOT NULL,
	"value" text NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "attribute_values_attribute_id_code_unique" UNIQUE("attribute_id","code"),
	CONSTRAINT "attribute_values_code_format" CHECK ("product"."attribute_values"."code" ~ '^[A-Z0-9]{1,6}$')
);
--> statement-breakpoint
CREATE TABLE "product"."attributes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product"."categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sku_pattern" text NOT NULL,
	"sku_next_seq" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product"."product_channel_specs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"external_category_id" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "product_channel_specs_product_id_platform_unique" UNIQUE("product_id","platform")
);
--> statement-breakpoint
CREATE TABLE "product"."product_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product"."product_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"business_status" "product"."business_status" DEFAULT 'selling' NOT NULL,
	"archived_at" timestamp with time zone,
	"standard_price" numeric(18, 2),
	"target_net_price" numeric(18, 2),
	"min_margin_pct" numeric(5, 2),
	"weight_g" integer,
	"length_mm" integer,
	"width_mm" integer,
	"height_mm" integer,
	"source_request_line_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "product_variants_company_id_sku_unique" UNIQUE("company_id","sku"),
	CONSTRAINT "product_variants_archived" CHECK (("product"."product_variants"."business_status" = 'archived') = ("product"."product_variants"."archived_at" is not null)),
	CONSTRAINT "product_variants_prices" CHECK ("product"."product_variants"."standard_price" >= 0 and "product"."product_variants"."target_net_price" >= 0),
	CONSTRAINT "product_variants_dimensions" CHECK ("product"."product_variants"."weight_g" > 0 and "product"."product_variants"."length_mm" > 0 and "product"."product_variants"."width_mm" > 0 and "product"."product_variants"."height_mm" > 0)
);
--> statement-breakpoint
CREATE TABLE "product"."products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product"."variant_attribute_values" (
	"variant_id" uuid NOT NULL,
	"attribute_value_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "variant_attribute_values_variant_id_attribute_value_id_pk" PRIMARY KEY("variant_id","attribute_value_id"),
	CONSTRAINT "variant_attribute_values_position" CHECK ("product"."variant_attribute_values"."position" in (0, 1))
);
--> statement-breakpoint
CREATE TABLE "product"."doc_counters" (
	"company_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"period" text DEFAULT '' NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "doc_counters_company_id_doc_type_period_pk" PRIMARY KEY("company_id","doc_type","period")
);
--> statement-breakpoint
CREATE TABLE "product"."stock_document_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" integer,
	"book_qty" integer,
	"counted_qty" integer,
	"expected_qty" integer,
	"scanned_qty" integer,
	"resell_qty" integer,
	"damaged_qty" integer,
	"to_supplier_qty" integer,
	"actual_variant_id" uuid,
	"unit_cost" numeric(18, 2),
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "stock_document_lines_quantity" CHECK ("product"."stock_document_lines"."quantity" > 0),
	CONSTRAINT "stock_document_lines_counted" CHECK ("product"."stock_document_lines"."counted_qty" >= 0),
	CONSTRAINT "stock_document_lines_inspection" CHECK ("product"."stock_document_lines"."expected_qty" >= 0 and "product"."stock_document_lines"."scanned_qty" >= 0 and "product"."stock_document_lines"."resell_qty" >= 0 and "product"."stock_document_lines"."damaged_qty" >= 0
        and "product"."stock_document_lines"."to_supplier_qty" >= 0),
	CONSTRAINT "stock_document_lines_inspection_sum" CHECK ("product"."stock_document_lines"."scanned_qty" is null or "product"."stock_document_lines"."resell_qty" + "product"."stock_document_lines"."damaged_qty" + "product"."stock_document_lines"."to_supplier_qty" = "product"."stock_document_lines"."scanned_qty")
);
--> statement-breakpoint
CREATE TABLE "product"."stock_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"kind" "product"."stock_document_kind" NOT NULL,
	"status" "product"."stock_document_status" DEFAULT 'draft' NOT NULL,
	"area" "product"."stock_bucket" DEFAULT 'on_hand' NOT NULL,
	"counted_at" timestamp with time zone,
	"is_opening" boolean DEFAULT false NOT NULL,
	"source_type" text,
	"source_id" uuid,
	"claim_flag" boolean DEFAULT false NOT NULL,
	"reject_decision" "product"."reject_decision",
	"note" text,
	"status_reason" text,
	"created_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"self_approved" boolean DEFAULT false NOT NULL,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "stock_documents_company_id_number_unique" UNIQUE("company_id","number"),
	CONSTRAINT "stock_documents_second_person" CHECK ("product"."stock_documents"."approved_by" is null or "product"."stock_documents"."approved_by" is distinct from "product"."stock_documents"."created_by" or "product"."stock_documents"."self_approved"),
	CONSTRAINT "stock_documents_shipment_source" CHECK ("product"."stock_documents"."kind" not in ('shipment', 'shipment_reversal') or "product"."stock_documents"."source_type" is not distinct from 'package'),
	CONSTRAINT "stock_documents_counted_at" CHECK ("product"."stock_documents"."kind" <> 'stocktake' or "product"."stock_documents"."counted_at" is not null),
	CONSTRAINT "stock_documents_opening" CHECK (not "product"."stock_documents"."is_opening" or "product"."stock_documents"."kind" = 'stocktake'),
	CONSTRAINT "stock_documents_posted" CHECK (("product"."stock_documents"."status" = 'posted') = ("product"."stock_documents"."posted_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "product"."stock_levels" (
	"variant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"on_hand" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"quarantine" integer DEFAULT 0 NOT NULL,
	"avg_cost" numeric(18, 2) DEFAULT '0' NOT NULL,
	"min_qty" integer,
	"invariant_broken" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "stock_levels_company_id_variant_id_pk" PRIMARY KEY("company_id","variant_id"),
	CONSTRAINT "stock_levels_reserved" CHECK ("product"."stock_levels"."reserved" >= 0),
	CONSTRAINT "stock_levels_quarantine" CHECK ("product"."stock_levels"."quarantine" >= 0),
	CONSTRAINT "stock_levels_min_qty" CHECK ("product"."stock_levels"."min_qty" >= 0),
	CONSTRAINT "stock_levels_invariant" CHECK (("product"."stock_levels"."on_hand" >= 0 and "product"."stock_levels"."reserved" <= "product"."stock_levels"."on_hand") or "product"."stock_levels"."invariant_broken")
);
--> statement-breakpoint
CREATE TABLE "product"."stock_moves" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "product"."stock_moves_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"bucket" "product"."stock_bucket" NOT NULL,
	"qty_change" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"unit_cost" numeric(18, 2),
	"source_type" "product"."stock_source_type" NOT NULL,
	"source_id" uuid NOT NULL,
	"source_line_id" uuid,
	"done_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_moves_qty_change" CHECK ("product"."stock_moves"."qty_change" <> 0)
);
--> statement-breakpoint
CREATE TABLE "product"."goods_receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"request_line_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"declared_qty" integer DEFAULT 0 NOT NULL,
	"accepted_qty" integer DEFAULT 0 NOT NULL,
	"defective_qty" integer DEFAULT 0 NOT NULL,
	"returned_on_spot_qty" integer DEFAULT 0 NOT NULL,
	"shortage_qty" integer GENERATED ALWAYS AS (declared_qty - accepted_qty - defective_qty - returned_on_spot_qty) STORED,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "goods_receipt_lines_receipt_id_request_line_id_unique" UNIQUE("receipt_id","request_line_id"),
	CONSTRAINT "goods_receipt_lines_counts" CHECK ("product"."goods_receipt_lines"."declared_qty" >= 0 and "product"."goods_receipt_lines"."accepted_qty" >= 0 and "product"."goods_receipt_lines"."defective_qty" >= 0 and "product"."goods_receipt_lines"."returned_on_spot_qty" >= 0),
	CONSTRAINT "goods_receipt_lines_within_declared" CHECK ("product"."goods_receipt_lines"."accepted_qty" + "product"."goods_receipt_lines"."defective_qty" + "product"."goods_receipt_lines"."returned_on_spot_qty" <= "product"."goods_receipt_lines"."declared_qty")
);
--> statement-breakpoint
CREATE TABLE "product"."goods_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"request_id" uuid NOT NULL,
	"delivery_mode" "product"."delivery_mode" NOT NULL,
	"box_count" integer,
	"status" "product"."goods_receipt_status" DEFAULT 'counting' NOT NULL,
	"check_deadline" timestamp with time zone,
	"short_resolution" "product"."short_resolution",
	"follow_up_receipt_id" uuid,
	"resolution_note" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"note" text,
	"status_reason" text,
	"created_by" uuid,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "goods_receipts_company_id_number_unique" UNIQUE("company_id","number"),
	CONSTRAINT "goods_receipts_box_count" CHECK ("product"."goods_receipts"."box_count" > 0),
	CONSTRAINT "goods_receipts_resolved" CHECK (("product"."goods_receipts"."status" = 'resolved') = ("product"."goods_receipts"."short_resolution" is not null)),
	CONSTRAINT "goods_receipts_follow_up" CHECK (("product"."goods_receipts"."short_resolution" = 'follow_up') = ("product"."goods_receipts"."follow_up_receipt_id" is not null)),
	CONSTRAINT "goods_receipts_posted" CHECK (("product"."goods_receipts"."status" in ('matched', 'short', 'resolved')) = ("product"."goods_receipts"."posted_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "product"."purchase_request_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"variant_id" uuid,
	"new_product_name" text,
	"new_category_id" uuid,
	"new_variant_attrs" jsonb,
	"ordered_qty" integer NOT NULL,
	"received_qty" integer DEFAULT 0 NOT NULL,
	"defective_qty" integer DEFAULT 0 NOT NULL,
	"closed_short_qty" integer DEFAULT 0 NOT NULL,
	"unit_price" numeric(18, 2) NOT NULL,
	"excluded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "purchase_request_lines_item" CHECK ("product"."purchase_request_lines"."variant_id" is not null or "product"."purchase_request_lines"."new_product_name" is not null),
	CONSTRAINT "purchase_request_lines_ordered" CHECK ("product"."purchase_request_lines"."ordered_qty" > 0),
	CONSTRAINT "purchase_request_lines_counts" CHECK ("product"."purchase_request_lines"."received_qty" >= 0 and "product"."purchase_request_lines"."defective_qty" >= 0 and "product"."purchase_request_lines"."closed_short_qty" >= 0),
	CONSTRAINT "purchase_request_lines_outstanding" CHECK ("product"."purchase_request_lines"."ordered_qty" - "product"."purchase_request_lines"."received_qty" - "product"."purchase_request_lines"."defective_qty" - "product"."purchase_request_lines"."closed_short_qty" >= 0),
	CONSTRAINT "purchase_request_lines_unit_price" CHECK ("product"."purchase_request_lines"."unit_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "product"."purchase_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"supplier_id" uuid,
	"status" "product"."purchase_request_status" DEFAULT 'draft' NOT NULL,
	"source" "product"."purchase_request_source" DEFAULT 'manual' NOT NULL,
	"source_return_id" uuid,
	"expected_delivery_date" date,
	"note" text,
	"status_reason" text,
	"created_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"self_approved" boolean DEFAULT false NOT NULL,
	"ordered_by" uuid,
	"ordered_at" timestamp with time zone,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "purchase_requests_company_id_number_unique" UNIQUE("company_id","number"),
	CONSTRAINT "purchase_requests_second_person" CHECK ("product"."purchase_requests"."approved_by" is null or "product"."purchase_requests"."approved_by" is distinct from "product"."purchase_requests"."created_by" or "product"."purchase_requests"."self_approved"),
	CONSTRAINT "purchase_requests_supplier" CHECK ("product"."purchase_requests"."status" in ('draft', 'cancelled') or "product"."purchase_requests"."supplier_id" is not null),
	CONSTRAINT "purchase_requests_replacement" CHECK (("product"."purchase_requests"."source" = 'replacement') = ("product"."purchase_requests"."source_return_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "product"."supplier_return_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"return_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_cost" numeric(18, 2),
	"source_line_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "supplier_return_lines_quantity" CHECK ("product"."supplier_return_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "product"."supplier_returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"supplier_id" uuid,
	"status" "product"."supplier_return_status" DEFAULT 'draft' NOT NULL,
	"source" "product"."supplier_return_source" NOT NULL,
	"source_id" uuid,
	"refund_amount" numeric(18, 2),
	"replacement_request_id" uuid,
	"cancel_decision" "product"."cancel_decision",
	"note" text,
	"status_reason" text,
	"created_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"self_approved" boolean DEFAULT false NOT NULL,
	"sent_by" uuid,
	"sent_at" timestamp with time zone,
	"result_by" uuid,
	"result_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "supplier_returns_company_id_number_unique" UNIQUE("company_id","number"),
	CONSTRAINT "supplier_returns_second_person" CHECK ("product"."supplier_returns"."approved_by" is null or "product"."supplier_returns"."approved_by" is distinct from "product"."supplier_returns"."created_by" or "product"."supplier_returns"."self_approved"),
	CONSTRAINT "supplier_returns_supplier" CHECK ("product"."supplier_returns"."status" in ('draft', 'cancelled') or "product"."supplier_returns"."supplier_id" is not null),
	CONSTRAINT "supplier_returns_refund" CHECK (("product"."supplier_returns"."status" = 'refunded') = ("product"."supplier_returns"."refund_amount" is not null)),
	CONSTRAINT "supplier_returns_refund_amount" CHECK ("product"."supplier_returns"."refund_amount" >= 1),
	CONSTRAINT "supplier_returns_cancel" CHECK (("product"."supplier_returns"."status" = 'cancelled') = ("product"."supplier_returns"."cancel_decision" is not null)),
	CONSTRAINT "supplier_returns_result_by" CHECK ("product"."supplier_returns"."result_by" is null or "product"."supplier_returns"."result_by" is distinct from "product"."supplier_returns"."sent_by")
);
--> statement-breakpoint
CREATE TABLE "product"."suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"address" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD CONSTRAINT "listings_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "channel"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."price_calculations" ADD CONSTRAINT "price_calculations_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "channel"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."raw_orders" ADD CONSTRAINT "raw_orders_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "channel"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."conversation_notes" ADD CONSTRAINT "conversation_notes_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "channel"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."conversation_tags" ADD CONSTRAINT "conversation_tags_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "channel"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."conversation_tags" ADD CONSTRAINT "conversation_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "channel"."tags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."conversations" ADD CONSTRAINT "conversations_message_channel_id_message_channels_id_fk" FOREIGN KEY ("message_channel_id") REFERENCES "channel"."message_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "channel"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."member_roles" ADD CONSTRAINT "member_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "core"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "core"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."role_permissions" ADD CONSTRAINT "role_permissions_permission_code_permissions_code_fk" FOREIGN KEY ("permission_code") REFERENCES "core"."permissions"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."attachments" ADD CONSTRAINT "attachments_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "core"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."invitations" ADD CONSTRAINT "invitations_created_by_accounts_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."invitations" ADD CONSTRAINT "invitations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "core"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."invitations" ADD CONSTRAINT "invitations_decided_by_accounts_id_fk" FOREIGN KEY ("decided_by") REFERENCES "core"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."memberships" ADD CONSTRAINT "memberships_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "core"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."config_versions" ADD CONSTRAINT "config_versions_supersedes_id_config_versions_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "finance"."config_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."ledger_entries" ADD CONSTRAINT "ledger_entries_replaces_entry_id_ledger_entries_id_fk" FOREIGN KEY ("replaces_entry_id") REFERENCES "finance"."ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."ledger_entries" ADD CONSTRAINT "ledger_entries_settlement_line_id_settlement_lines_id_fk" FOREIGN KEY ("settlement_line_id") REFERENCES "finance"."settlement_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."payment_vouchers" ADD CONSTRAINT "payment_vouchers_supplier_invoice_id_supplier_invoices_id_fk" FOREIGN KEY ("supplier_invoice_id") REFERENCES "finance"."supplier_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."payment_vouchers" ADD CONSTRAINT "payment_vouchers_unmatched_receipt_id_unmatched_receipts_id_fk" FOREIGN KEY ("unmatched_receipt_id") REFERENCES "finance"."unmatched_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."payment_vouchers" ADD CONSTRAINT "payment_vouchers_reversal_of_id_payment_vouchers_id_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "finance"."payment_vouchers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."receipts" ADD CONSTRAINT "receipts_unmatched_receipt_id_unmatched_receipts_id_fk" FOREIGN KEY ("unmatched_receipt_id") REFERENCES "finance"."unmatched_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."receipts" ADD CONSTRAINT "receipts_settlement_line_id_settlement_lines_id_fk" FOREIGN KEY ("settlement_line_id") REFERENCES "finance"."settlement_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."receipts" ADD CONSTRAINT "receipts_reversal_of_id_receipts_id_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "finance"."receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_invoice_id_sales_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "finance"."sales_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."sales_invoices" ADD CONSTRAINT "sales_invoices_reversal_of_id_sales_invoices_id_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "finance"."sales_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."settlement_lines" ADD CONSTRAINT "settlement_lines_statement_id_settlement_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "finance"."settlement_statements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."settlement_statements" ADD CONSTRAINT "settlement_statements_batch_id_settlement_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "finance"."settlement_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."payment_transactions" ADD CONSTRAINT "payment_transactions_payment_link_id_payment_links_id_fk" FOREIGN KEY ("payment_link_id") REFERENCES "finance"."payment_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insight"."document_chunks" ADD CONSTRAINT "document_chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "insight"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insight"."document_roles" ADD CONSTRAINT "document_roles_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "insight"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order"."package_lines" ADD CONSTRAINT "package_lines_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "order"."packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order"."customer_identities" ADD CONSTRAINT "customer_identities_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "order"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order"."order_lines" ADD CONSTRAINT "order_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "order"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order"."orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "order"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order"."return_request_lines" ADD CONSTRAINT "return_request_lines_request_id_return_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "order"."return_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order"."return_request_lines" ADD CONSTRAINT "return_request_lines_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "order"."order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order"."return_requests" ADD CONSTRAINT "return_requests_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "order"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product"."attribute_values" ADD CONSTRAINT "attribute_values_attribute_id_attributes_id_fk" FOREIGN KEY ("attribute_id") REFERENCES "product"."attributes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product"."product_channel_specs" ADD CONSTRAINT "product_channel_specs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "product"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product"."product_images" ADD CONSTRAINT "product_images_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "product"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product"."product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "product"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product"."products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "product"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product"."variant_attribute_values" ADD CONSTRAINT "variant_attribute_values_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "product"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product"."variant_attribute_values" ADD CONSTRAINT "variant_attribute_values_attribute_value_id_attribute_values_id_fk" FOREIGN KEY ("attribute_value_id") REFERENCES "product"."attribute_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product"."stock_document_lines" ADD CONSTRAINT "stock_document_lines_document_id_stock_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "product"."stock_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product"."goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_receipt_id_goods_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "product"."goods_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product"."goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_request_line_id_purchase_request_lines_id_fk" FOREIGN KEY ("request_line_id") REFERENCES "product"."purchase_request_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product"."goods_receipts" ADD CONSTRAINT "goods_receipts_request_id_purchase_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "product"."purchase_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product"."purchase_request_lines" ADD CONSTRAINT "purchase_request_lines_request_id_purchase_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "product"."purchase_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product"."purchase_requests" ADD CONSTRAINT "purchase_requests_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "product"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product"."supplier_return_lines" ADD CONSTRAINT "supplier_return_lines_return_id_supplier_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "product"."supplier_returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product"."supplier_returns" ADD CONSTRAINT "supplier_returns_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "product"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "listings_shop_variant_uq" ON "channel"."listings" USING btree ("shop_id","variant_id") WHERE "channel"."listings"."variant_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "listings_shop_external_sku_uq" ON "channel"."listings" USING btree ("shop_id","external_sku_id") WHERE "channel"."listings"."external_sku_id" is not null;--> statement-breakpoint
CREATE INDEX "listings_variant_id_index" ON "channel"."listings" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "price_calculations_shop_id_variant_id_index" ON "channel"."price_calculations" USING btree ("shop_id","variant_id");--> statement-breakpoint
CREATE INDEX "raw_orders_order_id_index" ON "channel"."raw_orders" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "conversation_notes_conversation_id_index" ON "channel"."conversation_notes" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "conversation_tags_tag_id_index" ON "channel"."conversation_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "conversations_message_channel_id_index" ON "channel"."conversations" USING btree ("message_channel_id");--> statement-breakpoint
CREATE INDEX "conversations_assignee_id_index" ON "channel"."conversations" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_id_index" ON "channel"."messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "member_roles_role_id_index" ON "core"."member_roles" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "audit_logs_company_id_created_at_index" ON "core"."audit_logs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "attachments_entity_type_entity_id_index" ON "core"."attachments" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "attachments_file_id_index" ON "core"."attachments" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_account_id_index" ON "core"."refresh_tokens" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "outbox_messages_unpublished_idx" ON "core"."outbox_messages" USING btree ("id") WHERE "core"."outbox_messages"."published_at" is null;--> statement-breakpoint
CREATE INDEX "state_transitions_entity_type_entity_id_at_index" ON "core"."state_transitions" USING btree ("entity_type","entity_id","at");--> statement-breakpoint
CREATE INDEX "invitations_queue_idx" ON "core"."invitations" USING btree ("company_id","status","submitted_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "invitations_created_idx" ON "core"."invitations" USING btree ("company_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "invitations_created_by_index" ON "core"."invitations" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "invitations_account_id_index" ON "core"."invitations" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "invitations_decided_by_index" ON "core"."invitations" USING btree ("decided_by");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_one_pending_per_email" ON "core"."invitations" USING btree ("company_id","email") WHERE "core"."invitations"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "memberships_account_id_index" ON "core"."memberships" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "config_versions_kind_shop_id_status_index" ON "finance"."config_versions" USING btree ("kind","shop_id","status");--> statement-breakpoint
CREATE INDEX "ledger_entries_order_id_index" ON "finance"."ledger_entries" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_shop_id_occurred_on_index" ON "finance"."ledger_entries" USING btree ("shop_id","occurred_on");--> statement-breakpoint
CREATE INDEX "ledger_entries_occurred_on_index" ON "finance"."ledger_entries" USING btree ("occurred_on");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_replaces_uq" ON "finance"."ledger_entries" USING btree ("replaces_entry_id") WHERE "finance"."ledger_entries"."replaces_entry_id" is not null;--> statement-breakpoint
CREATE INDEX "order_settlements_status_index" ON "finance"."order_settlements" USING btree ("status");--> statement-breakpoint
CREATE INDEX "payment_vouchers_order_id_index" ON "finance"."payment_vouchers" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payment_vouchers_unmatched_receipt_id_index" ON "finance"."payment_vouchers" USING btree ("unmatched_receipt_id");--> statement-breakpoint
CREATE INDEX "receipts_order_id_index" ON "finance"."receipts" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "receipts_unmatched_receipt_id_index" ON "finance"."receipts" USING btree ("unmatched_receipt_id");--> statement-breakpoint
CREATE INDEX "sales_invoice_lines_invoice_id_index" ON "finance"."sales_invoice_lines" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "sales_invoices_order_id_index" ON "finance"."sales_invoices" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_invoices_one_posted_per_order" ON "finance"."sales_invoices" USING btree ("order_id") WHERE "finance"."sales_invoices"."reversal_of_id" is null and "finance"."sales_invoices"."status" = 'posted';--> statement-breakpoint
CREATE INDEX "settlement_batches_shop_id_index" ON "finance"."settlement_batches" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "settlement_lines_statement_id_index" ON "finance"."settlement_lines" USING btree ("statement_id");--> statement-breakpoint
CREATE INDEX "settlement_lines_order_id_index" ON "finance"."settlement_lines" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "settlement_statements_shop_id_index" ON "finance"."settlement_statements" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "supplier_invoices_supplier_id_index" ON "finance"."supplier_invoices" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "supplier_invoices_purchase_request_id_index" ON "finance"."supplier_invoices" USING btree ("purchase_request_id");--> statement-breakpoint
CREATE INDEX "unmatched_receipts_payment_transaction_id_index" ON "finance"."unmatched_receipts" USING btree ("payment_transaction_id");--> statement-breakpoint
CREATE INDEX "unmatched_receipts_assigned_order_id_index" ON "finance"."unmatched_receipts" USING btree ("assigned_order_id");--> statement-breakpoint
CREATE INDEX "payment_links_order_id_index" ON "finance"."payment_links" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_links_one_active_per_order" ON "finance"."payment_links" USING btree ("order_id") WHERE "finance"."payment_links"."status" = 'active';--> statement-breakpoint
CREATE INDEX "payment_transactions_payment_link_id_index" ON "finance"."payment_transactions" USING btree ("payment_link_id");--> statement-breakpoint
CREATE INDEX "payment_transactions_order_id_index" ON "finance"."payment_transactions" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "document_roles_role_id_index" ON "insight"."document_roles" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "package_lines_package_id_index" ON "order"."package_lines" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "package_lines_variant_id_index" ON "order"."package_lines" USING btree ("variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "packages_platform_code_order_uq" ON "order"."packages" USING btree ("shop_id","platform_package_code","order_id") WHERE "order"."packages"."platform_package_code" is not null;--> statement-breakpoint
CREATE INDEX "packages_order_id_index" ON "order"."packages" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "packages_status_index" ON "order"."packages" USING btree ("status");--> statement-breakpoint
CREATE INDEX "packages_tracking_code_index" ON "order"."packages" USING btree ("tracking_code");--> statement-breakpoint
CREATE INDEX "unmatched_return_parcels_status_index" ON "order"."unmatched_return_parcels" USING btree ("status");--> statement-breakpoint
CREATE INDEX "customer_identities_customer_id_index" ON "order"."customer_identities" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "order_lines_order_id_index" ON "order"."order_lines" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_lines_variant_id_index" ON "order"."order_lines" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "orders_customer_id_index" ON "order"."orders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "orders_conversation_id_index" ON "order"."orders" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "orders_status_index" ON "order"."orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "return_request_lines_request_id_index" ON "order"."return_request_lines" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "return_request_lines_order_line_id_index" ON "order"."return_request_lines" USING btree ("order_line_id");--> statement-breakpoint
CREATE INDEX "return_requests_order_id_index" ON "order"."return_requests" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "return_requests_status_index" ON "order"."return_requests" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_values_attribute_lower_value_uq" ON "product"."attribute_values" USING btree ("attribute_id",lower("value"));--> statement-breakpoint
CREATE UNIQUE INDEX "attributes_company_lower_name_uq" ON "product"."attributes" USING btree ("company_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "categories_company_lower_name_uq" ON "product"."categories" USING btree ("company_id",lower("name"));--> statement-breakpoint
CREATE INDEX "product_images_product_id_index" ON "product"."product_images" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "product_images_file_id_index" ON "product"."product_images" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "product_variants_product_id_index" ON "product"."product_variants" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_company_lower_name_uq" ON "product"."products" USING btree ("company_id",lower("name")) WHERE "product"."products"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "products_category_id_index" ON "product"."products" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "variant_attribute_values_attribute_value_id_index" ON "product"."variant_attribute_values" USING btree ("attribute_value_id");--> statement-breakpoint
CREATE INDEX "stock_document_lines_document_id_index" ON "product"."stock_document_lines" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "stock_document_lines_variant_id_index" ON "product"."stock_document_lines" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "stock_documents_kind_status_index" ON "product"."stock_documents" USING btree ("kind","status");--> statement-breakpoint
CREATE INDEX "stock_documents_source_type_source_id_index" ON "product"."stock_documents" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "stock_moves_variant_id_id_index" ON "product"."stock_moves" USING btree ("variant_id","id");--> statement-breakpoint
CREATE INDEX "stock_moves_source_type_source_id_index" ON "product"."stock_moves" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "goods_receipt_lines_variant_id_index" ON "product"."goods_receipt_lines" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "goods_receipts_request_id_index" ON "product"."goods_receipts" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "purchase_request_lines_request_id_index" ON "product"."purchase_request_lines" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "purchase_request_lines_variant_id_index" ON "product"."purchase_request_lines" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "purchase_requests_status_index" ON "product"."purchase_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "purchase_requests_supplier_id_index" ON "product"."purchase_requests" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "supplier_return_lines_return_id_index" ON "product"."supplier_return_lines" USING btree ("return_id");--> statement-breakpoint
CREATE INDEX "supplier_return_lines_variant_id_index" ON "product"."supplier_return_lines" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "supplier_returns_status_index" ON "product"."supplier_returns" USING btree ("status");