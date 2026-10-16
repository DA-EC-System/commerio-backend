CREATE TYPE "access"."role_kind" AS ENUM('builtin', 'custom');--> statement-breakpoint
CREATE TYPE "audit"."audit_action" AS ENUM('create', 'update', 'delete');--> statement-breakpoint
CREATE TYPE "platform"."company_status" AS ENUM('active', 'locked');--> statement-breakpoint
CREATE TYPE "platform"."module_code" AS ENUM('platform', 'identity', 'catalog', 'pricing', 'inventory', 'sales', 'fulfillment', 'finance', 'payment', 'notification', 'purchasing', 'channel', 'inbox', 'assistant', 'report');--> statement-breakpoint
CREATE TYPE "staff"."membership_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TABLE "access"."member_roles" (
	"membership_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	CONSTRAINT "member_roles_membership_id_role_id_pk" PRIMARY KEY("membership_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "access"."permissions" (
	"code" text PRIMARY KEY NOT NULL,
	"module_code" text NOT NULL,
	"description" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "access"."role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_code" text NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_code_pk" PRIMARY KEY("role_id","permission_code")
);
--> statement-breakpoint
CREATE TABLE "access"."roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"name" text NOT NULL,
	"kind" "access"."role_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "roles_company_id_name_unique" UNIQUE NULLS NOT DISTINCT("company_id","name")
);
--> statement-breakpoint
CREATE TABLE "audit"."audit_logs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit"."audit_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" uuid,
	"actor_id" uuid,
	"action" "audit"."audit_action" NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files"."files" (
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
CREATE TABLE "identity"."refresh_tokens" (
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
CREATE TABLE "platform"."companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"tax_code" text NOT NULL,
	"status" "platform"."company_status" DEFAULT 'active' NOT NULL,
	"lock_reason" text,
	"locked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."company_modules" (
	"company_id" uuid NOT NULL,
	"module_code" "platform"."module_code" NOT NULL,
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
CREATE TABLE "staff"."accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"full_name" text NOT NULL,
	"password_hash" text,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"google_sub" text,
	"is_platform_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "accounts_email_unique" UNIQUE("email"),
	CONSTRAINT "accounts_google_sub_unique" UNIQUE("google_sub")
);
--> statement-breakpoint
CREATE TABLE "staff"."memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"status" "staff"."membership_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "memberships_company_id_account_id_unique" UNIQUE("company_id","account_id")
);
--> statement-breakpoint
ALTER TABLE "access"."member_roles" ADD CONSTRAINT "member_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "access"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access"."role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "access"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access"."role_permissions" ADD CONSTRAINT "role_permissions_permission_code_permissions_code_fk" FOREIGN KEY ("permission_code") REFERENCES "access"."permissions"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff"."memberships" ADD CONSTRAINT "memberships_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "staff"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_roles_role_id_index" ON "access"."member_roles" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "audit_logs_company_id_created_at_index" ON "audit"."audit_logs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "refresh_tokens_account_id_index" ON "identity"."refresh_tokens" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "memberships_account_id_index" ON "staff"."memberships" USING btree ("account_id");